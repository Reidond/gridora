import { constants as fsConstants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import {
  AgentSelfUpdatePayload,
  AgentUpdateManifest,
  canonicalAgentUpdateManifest,
  canonicalJson,
  type AgentCommand,
} from '@gridora/agent-protocol'
import { Effect, Layer, Schema } from 'effect'
import { AgentError } from './errors.js'
import { AgentSelfUpdate, type AgentSelfUpdateProof } from './services.js'

export const AGENT_UPDATE_POLICY_PATH = '/etc/gridora/agent-update-policy.json' as const
export const AGENT_UPDATE_RELEASE_SIGNING_PUBLIC_KEY_PATH =
  '/etc/gridora/agent-release-signing-public.pem' as const
export const AGENT_UPDATE_STAGING_DIRECTORY = '/var/lib/gridora/agent-updates/staged' as const
export const AGENT_UPDATE_SOCKET = '/run/gridora/agent-update.sock' as const
export const AGENT_UPDATE_HEALTH_PATH =
  '/var/lib/gridora/agent-updates/health/receipt.json' as const

const MAX_POLICY_BYTES = 8 * 1024
const MAX_SOCKET_BYTES = 8 * 1024
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const AGENT_COMMAND_API_VERSION = 'agent.gridora.dev/v1alpha1' as const
const UPDATE_API_VERSION = 'agent-update.gridora.dev/v1alpha1' as const

const Hostname = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(253),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  Schema.makeFilter((value) =>
    value.includes('..') || value.includes('/') ? 'artifact host is not canonical' : undefined,
  ),
)

export const AgentUpdatePolicy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  allowedArtifactHosts: Schema.Array(Hostname).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  maximumArtifactBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: MAX_ARTIFACT_BYTES }),
  ),
  commandApiVersion: Schema.Literal(AGENT_COMMAND_API_VERSION),
  controlPlaneApiVersion: Schema.Literal(AGENT_COMMAND_API_VERSION),
})
export type AgentUpdatePolicy = typeof AgentUpdatePolicy.Type

export class AgentUpdateError extends Error {
  override readonly name = 'AgentUpdateError'
  constructor(
    readonly code:
      | 'invalid-manifest'
      | 'signature-rejected'
      | 'source-rejected'
      | 'compatibility-rejected'
      | 'artifact-rejected'
      | 'unsafe-filesystem'
      | 'helper-unavailable'
      | 'helper-response-pending'
      | 'helper-rejected',
  ) {
    super('agent update operation failed')
  }
}

export interface AgentUpdatePaths {
  readonly policyPath: string
  readonly releaseSigningPublicKeyPath: string
  readonly stagingDirectory: string
  readonly socketPath: string
  readonly healthPath: string
}

export const productionAgentUpdatePaths: AgentUpdatePaths = {
  policyPath: AGENT_UPDATE_POLICY_PATH,
  releaseSigningPublicKeyPath: AGENT_UPDATE_RELEASE_SIGNING_PUBLIC_KEY_PATH,
  stagingDirectory: AGENT_UPDATE_STAGING_DIRECTORY,
  socketPath: AGENT_UPDATE_SOCKET,
  healthPath: AGENT_UPDATE_HEALTH_PATH,
}

export interface AgentUpdateStageOptions {
  readonly paths: AgentUpdatePaths
  /** Trusted policy/key owners. Production is always root (0). */
  readonly trustedUid: number
  /** The unprivileged agent UID that owns the sealed staging directory/files. */
  readonly agentUid: number
  readonly agentGid: number
  readonly architecture: 'amd64' | 'arm64'
  readonly now?: () => Date
  readonly download?: (url: string, maximumBytes: number) => Promise<Uint8Array>
  readonly activate?: (request: AgentUpdateActivationRequest) => Promise<AgentUpdateActivationProof>
}

export interface AgentUpdateActivationRequest {
  readonly apiVersion: typeof UPDATE_API_VERSION
  readonly action: 'activate'
  readonly digest: string
  readonly version: string
  readonly architecture: 'amd64' | 'arm64'
  readonly commandId: string
  readonly operationId: string
}

export interface AgentUpdateActivationProof {
  readonly status: 'active' | 'rolled-back' | 'pending'
  readonly version: string
  readonly digest: string
  readonly commandId: string
  readonly operationId: string
  readonly duplicate: boolean
  readonly observedAt: string
  readonly retainedReleaseCount?: number
}

export interface StagedAgentUpdate {
  readonly manifest: AgentUpdateManifest
  readonly digest: string
  readonly artifactPath: string
  readonly manifestPath: string
}

const mode = (value: number) => value & 0o7777
const safeError = (code: AgentUpdateError['code']) => new AgentUpdateError(code)
const digestHex = (digest: string) => digest.slice('sha256:'.length)

const assertPathIsCanonical = (path: string): void => {
  if (!path.startsWith('/') || resolve(path) !== path || path.includes('\0'))
    throw safeError('unsafe-filesystem')
}

const assertTrustedDirectoryChain = async (path: string, trustedUid: number): Promise<void> => {
  let current = resolve(path)
  while (true) {
    const metadata = await lstat(current).catch(() => {
      throw safeError('unsafe-filesystem')
    })
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.uid !== trustedUid && metadata.uid !== 0) ||
      (mode(metadata.mode) & 0o022) !== 0
    )
      throw safeError('unsafe-filesystem')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const assertTrustedRegularFile = async (
  path: string,
  trustedUid: number,
  maximumBytes: number,
): Promise<void> => {
  assertPathIsCanonical(path)
  await assertTrustedDirectoryChain(dirname(path), trustedUid)
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== trustedUid ||
    (mode(metadata.mode) & 0o022) !== 0 ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  )
    throw safeError('unsafe-filesystem')
}

const assertAgentStagingDirectory = async (
  directory: string,
  options: AgentUpdateStageOptions,
): Promise<void> => {
  assertPathIsCanonical(directory)
  await assertTrustedDirectoryChain(dirname(directory), options.trustedUid)
  const metadata = await lstat(directory).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== options.agentUid ||
    metadata.gid !== options.agentGid ||
    mode(metadata.mode) !== 0o700
  )
    throw safeError('unsafe-filesystem')
}

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const validateArtifactSource = (source: string, policy: AgentUpdatePolicy): URL => {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw safeError('source-rejected')
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
    host.includes('..') ||
    !policy.allowedArtifactHosts.includes(host) ||
    !url.pathname.startsWith('/') ||
    url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
  )
    throw safeError('source-rejected')
  return url
}

const decodePolicy = async (path: string, trustedUid: number): Promise<AgentUpdatePolicy> => {
  await assertTrustedRegularFile(path, trustedUid, MAX_POLICY_BYTES)
  try {
    return await Schema.decodeUnknownPromise(AgentUpdatePolicy, { onExcessProperty: 'error' })(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    )
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  }
}

const readReleaseSigningKey = async (path: string, trustedUid: number) => {
  await assertTrustedRegularFile(path, trustedUid, 4 * 1024)
  try {
    const key = createPublicKey(await readFile(path, 'utf8'))
    if (key.asymmetricKeyType !== 'ed25519') throw safeError('signature-rejected')
    return key
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('signature-rejected')
  }
}

export const verifyAgentUpdateManifest = async (
  input: unknown,
  options: Pick<AgentUpdateStageOptions, 'paths' | 'trustedUid' | 'architecture' | 'now'>,
): Promise<{ readonly manifest: AgentUpdateManifest; readonly policy: AgentUpdatePolicy }> => {
  let manifest: AgentUpdateManifest
  try {
    manifest = await Schema.decodeUnknownPromise(AgentUpdateManifest, {
      onExcessProperty: 'error',
    })(input)
  } catch {
    throw safeError('invalid-manifest')
  }
  const policy = await decodePolicy(options.paths.policyPath, options.trustedUid)
  const key = await readReleaseSigningKey(
    options.paths.releaseSigningPublicKeyPath,
    options.trustedUid,
  )
  if (
    manifest.architecture !== options.architecture ||
    manifest.compatibility.commandApiVersion !== AGENT_COMMAND_API_VERSION ||
    manifest.compatibility.minimumControlPlaneApiVersion !== policy.controlPlaneApiVersion ||
    manifest.compatibility.maximumControlPlaneApiVersion !== policy.controlPlaneApiVersion ||
    policy.commandApiVersion !== AGENT_COMMAND_API_VERSION
  )
    throw safeError('compatibility-rejected')
  validateArtifactSource(manifest.source.url, policy)
  if (manifest.source.sizeBytes > policy.maximumArtifactBytes) throw safeError('artifact-rejected')
  const issuedAt = Date.parse(manifest.issuedAt)
  const now = (options.now ?? (() => new Date()))().getTime()
  if (!Number.isFinite(issuedAt) || issuedAt > now + 5 * 60_000) throw safeError('invalid-manifest')
  let signature: Buffer
  try {
    signature = Buffer.from(manifest.signature, 'base64')
  } catch {
    throw safeError('signature-rejected')
  }
  if (
    signature.byteLength !== 64 ||
    !verify(null, Buffer.from(canonicalAgentUpdateManifest(manifest), 'utf8'), key, signature)
  )
    throw safeError('signature-rejected')
  return { manifest, policy }
}

export const stagePathsForDigest = (stagingDirectory: string, digest: string) => {
  assertPathIsCanonical(stagingDirectory)
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw safeError('invalid-manifest')
  const suffix = digestHex(digest)
  const artifactPath = join(stagingDirectory, `${suffix}.artifact`)
  const manifestPath = join(stagingDirectory, `${suffix}.manifest.json`)
  if (
    resolve(artifactPath) !== artifactPath ||
    resolve(manifestPath) !== manifestPath ||
    dirname(artifactPath) !== stagingDirectory ||
    dirname(manifestPath) !== stagingDirectory
  )
    throw safeError('unsafe-filesystem')
  return { artifactPath, manifestPath }
}

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const defaultDownload = async (url: string, maximumBytes: number): Promise<Uint8Array> => {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/octet-stream' },
  })
  if (!response.ok || response.body === null) throw safeError('artifact-rejected')
  const advertised = response.headers.get('content-length')
  if (advertised !== null) {
    const bytes = Number(advertised)
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maximumBytes)
      throw safeError('artifact-rejected')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maximumBytes) throw safeError('artifact-rejected')
    chunks.push(chunk)
  }
  if (total < 1) throw safeError('artifact-rejected')
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const assertStagedFile = async (
  path: string,
  options: AgentUpdateStageOptions,
  expectedSize: number,
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
    metadata.size !== expectedSize
  )
    throw safeError('unsafe-filesystem')
}

const readExactStagedFile = async (
  path: string,
  options: AgentUpdateStageOptions,
  expectedSize: number,
): Promise<Buffer> => {
  await assertStagedFile(path, options, expectedSize)
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.uid !== options.agentUid ||
      before.gid !== options.agentGid ||
      mode(before.mode) !== 0o600 ||
      before.nlink !== 1 ||
      before.size !== expectedSize
    )
      throw safeError('unsafe-filesystem')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.uid !== options.agentUid ||
      after.gid !== options.agentGid ||
      mode(after.mode) !== 0o600 ||
      after.nlink !== 1 ||
      bytes.byteLength !== expectedSize
    )
      throw safeError('unsafe-filesystem')
    return bytes
  } finally {
    await handle.close()
  }
}

const atomicStageWrite = async (
  destination: string,
  bytes: Uint8Array,
  options: AgentUpdateStageOptions,
): Promise<void> => {
  const directory = options.paths.stagingDirectory
  if (process.getuid?.() !== options.agentUid || process.getgid?.() !== options.agentGid)
    throw safeError('unsafe-filesystem')
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.chmod(0o600)
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      metadata.uid !== options.agentUid ||
      metadata.gid !== options.agentGid ||
      mode(metadata.mode) !== 0o600 ||
      metadata.size !== bytes.byteLength
    )
      throw safeError('unsafe-filesystem')
    await handle.close()
    handle = undefined
    await rename(temporary, destination)
    await syncDirectory(directory)
    await assertStagedFile(destination, options, bytes.byteLength)
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

const ensureStageFile = async (
  path: string,
  bytes: Uint8Array,
  options: AgentUpdateStageOptions,
): Promise<void> => {
  try {
    await lstat(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      await atomicStageWrite(path, bytes, options)
      return
    }
    throw safeError('unsafe-filesystem')
  }
  // A collision must be an exact prior stage by the same unprivileged identity;
  // lstat/readNoFollow below rejects symlinks and malformed files rather than
  // treating them as a harmless cache hit.
  const existing = await readExactStagedFile(path, options, bytes.byteLength)
  if (!existing.equals(Buffer.from(bytes))) throw safeError('artifact-rejected')
}

export const stageAgentUpdate = async (
  input: unknown,
  options: AgentUpdateStageOptions,
): Promise<StagedAgentUpdate> => {
  await assertAgentStagingDirectory(options.paths.stagingDirectory, options)
  const { manifest, policy } = await verifyAgentUpdateManifest(input, options)
  const source = validateArtifactSource(manifest.source.url, policy)
  const download = options.download ?? defaultDownload
  let artifact: Uint8Array
  try {
    artifact = await download(
      source.toString(),
      Math.min(policy.maximumArtifactBytes, manifest.source.sizeBytes),
    )
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('artifact-rejected')
  }
  if (
    artifact.byteLength !== manifest.source.sizeBytes ||
    sha256(artifact) !== manifest.source.sha256
  )
    throw safeError('artifact-rejected')
  const paths = stagePathsForDigest(options.paths.stagingDirectory, manifest.source.sha256)
  await ensureStageFile(paths.artifactPath, artifact, options)
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')
  await ensureStageFile(paths.manifestPath, manifestBytes, options)
  return { manifest, digest: manifest.source.sha256, ...paths }
}

const ActivationProofSchema = Schema.Struct({
  status: Schema.Literals(['active', 'rolled-back', 'pending']),
  version: Schema.String,
  digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  commandId: Schema.String,
  operationId: Schema.String,
  duplicate: Schema.Boolean,
  observedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
  retainedReleaseCount: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2)),
  ),
})

const requestUpdateHelper = (
  socketPath: string,
  request: AgentUpdateActivationRequest,
): Promise<AgentUpdateActivationProof> =>
  new Promise((resolveRequest, rejectRequest) => {
    const body = JSON.stringify(request)
    const wire = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: '/v1/agent-updates/activate',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        timeout: 130_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0
        response.on('error', () => rejectRequest(safeError('helper-response-pending')))
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > MAX_SOCKET_BYTES) response.destroy(safeError('helper-response-pending'))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          if (response.statusCode === 409) {
            rejectRequest(safeError('helper-rejected'))
            return
          }
          if (response.statusCode !== 200) {
            rejectRequest(safeError('helper-response-pending'))
            return
          }
          void Schema.decodeUnknownPromise(ActivationProofSchema, {
            onExcessProperty: 'error',
          })(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
            .then((proof) => {
              const receipt: AgentUpdateActivationProof = {
                status: proof.status,
                version: proof.version,
                digest: proof.digest,
                commandId: proof.commandId,
                operationId: proof.operationId,
                duplicate: proof.duplicate,
                observedAt: proof.observedAt,
                ...(proof.retainedReleaseCount === undefined
                  ? {}
                  : { retainedReleaseCount: proof.retainedReleaseCount }),
              }
              resolveRequest(receipt)
            })
            .catch(() => rejectRequest(safeError('helper-response-pending')))
        })
      },
    )
    wire.on('timeout', () => wire.destroy(safeError('helper-response-pending')))
    wire.on('error', () => rejectRequest(safeError('helper-response-pending')))
    wire.end(body)
  })

export const makeAgentUpdateActivationClient =
  (
    socketPath: string = AGENT_UPDATE_SOCKET,
  ): ((request: AgentUpdateActivationRequest) => Promise<AgentUpdateActivationProof>) =>
  (request) =>
    requestUpdateHelper(socketPath, request)

const mapUpdateError = (cause: unknown): AgentError => {
  if (cause instanceof AgentUpdateError && cause.code === 'helper-response-pending')
    return new AgentError({
      code: 'update-response-pending',
      message: 'activation outcome was not durably observed; command remains pending',
    })
  return new AgentError({
    code: 'execution-failed',
    message: 'signed agent update was rejected or could not be staged',
  })
}

/**
 * Stages a release as the agent user, then sends only a digest-bound fixed
 * request to the root helper. Neither this client nor its protocol contains a
 * filesystem path or command to execute.
 */
export const makeAgentSelfUpdate = (
  options: AgentUpdateStageOptions,
): {
  readonly apply: (command: AgentCommand) => Effect.Effect<AgentSelfUpdateProof, AgentError>
} => ({
  apply: (command) =>
    Effect.tryPromise({
      try: async () => {
        const payload = await Schema.decodeUnknownPromise(AgentSelfUpdatePayload, {
          onExcessProperty: 'error',
        })(command.payload)
        const staged = await stageAgentUpdate(payload.manifest, options)
        const activate =
          options.activate ?? makeAgentUpdateActivationClient(options.paths.socketPath)
        const proof = await activate({
          apiVersion: UPDATE_API_VERSION,
          action: 'activate',
          digest: staged.digest,
          version: staged.manifest.version,
          architecture: staged.manifest.architecture,
          commandId: command.commandId,
          operationId: command.operationId,
        })
        if (
          proof.commandId !== command.commandId ||
          proof.operationId !== command.operationId ||
          proof.digest !== staged.digest ||
          proof.version !== staged.manifest.version
        )
          throw safeError('helper-response-pending')
        if (proof.status === 'pending') throw safeError('helper-response-pending')
        if (proof.status === 'rolled-back') throw safeError('helper-rejected')
        return {
          version: proof.version,
          digest: proof.digest,
          duplicate: proof.duplicate,
          observedAt: proof.observedAt,
        }
      },
      catch: mapUpdateError,
    }),
})

export const AgentSelfUpdateLive = (options: AgentUpdateStageOptions) =>
  Layer.succeed(AgentSelfUpdate, makeAgentSelfUpdate(options))

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import {
  TunnelCredentialCommandPayload,
  TunnelCredentialError,
  generateTunnelCredentialNodeKeyPair,
  withOpenedTunnelCredential,
  type AtomicCredentialInstallerShape,
  type TunnelCredentialAcknowledgement,
  type TunnelCredentialCommandPayload as TunnelCommand,
  type TunnelCredentialInstallPayload as InstallCommand,
  type TunnelCredentialRevokePayload as RevokeCommand,
} from '@gridora/tunnel-credential'

export const TUNNEL_INSTALLER_SOCKET = '/run/gridora/tunnel-installer.sock' as const
export const TUNNEL_CREDENTIAL_DIRECTORY = '/var/lib/gridora/tunnel' as const
export const TUNNEL_CREDENTIAL_PATH = '/var/lib/gridora/tunnel/credential' as const
export const TUNNEL_INSTALLER_STATE = '/var/lib/gridora/tunnel/installer-state.json' as const
export const TUNNEL_PRIVATE_KEY = '/var/lib/gridora/tunnel/node-private-key' as const
export const TUNNEL_PUBLIC_KEY = '/var/lib/gridora/tunnel/node-public-key' as const

const SYSTEMCTL = '/usr/bin/systemctl' as const
const MAX_REQUEST_BYTES = 192 * 1024
const execFileAsync = promisify(execFile)

export class TunnelInstallerError extends Error {
  override readonly name = 'TunnelInstallerError'
  constructor(
    readonly code:
      | 'invalid_request'
      | 'unsafe_filesystem'
      | 'scope_mismatch'
      | 'revision_conflict'
      | 'replay_rejected'
      | 'crypto_failed'
      | 'activation_failed'
      | 'state_failed'
      | 'unavailable'
      | 'invalid_response',
  ) {
    super('tunnel credential installer operation failed')
  }
}

export type TunnelSystemctlArguments =
  | readonly ['restart', 'cloudflared.service']
  | readonly ['stop', 'cloudflared.service']
  | readonly ['is-active', '--quiet', 'cloudflared.service']
  | readonly ['show', '--property=ActiveState', '--value', 'cloudflared.service']

export interface TunnelCommandRunner {
  readonly run: (command: typeof SYSTEMCTL, args: TunnelSystemctlArguments) => Promise<string>
}

export interface TunnelHealthProbe {
  /** Resolve only when cloudflared reports at least one ready connector. */
  readonly ready: () => Promise<void>
}

export const NodeTunnelCommandRunner: TunnelCommandRunner = {
  async run(command, args) {
    try {
      const result = await execFileAsync(command, [...args], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      })
      return result.stdout
    } catch {
      throw new TunnelInstallerError('activation_failed')
    }
  },
}

export const NodeTunnelHealthProbe: TunnelHealthProbe = {
  ready: () =>
    new Promise<void>((resolveReady, rejectReady) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: 20_000,
          path: '/ready',
          method: 'GET',
          timeout: 10_000,
          headers: { accept: 'text/plain' },
        },
        (response) => {
          let size = 0
          let settled = false
          const finish = (ready: boolean) => {
            if (settled) return
            settled = true
            if (ready) resolveReady()
            else rejectReady(safeError('activation_failed'))
          }
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength
            if (size > 1024) {
              finish(false)
              response.destroy()
            }
          })
          response.on('end', () => finish(response.statusCode === 200))
          response.on('aborted', () => finish(false))
          response.on('error', () => finish(false))
        },
      )
      request.on('timeout', () => request.destroy(safeError('activation_failed')))
      request.on('error', () => rejectReady(safeError('activation_failed')))
      request.end()
    }),
}

export interface TunnelInstallerPaths {
  readonly directory: string
  readonly credential: string
  readonly state: string
  readonly privateKey: string
  readonly publicKey: string
}

export interface TunnelInstallerOptions {
  readonly paths: TunnelInstallerPaths
  readonly rootUid: number
  readonly rootGid: number
  readonly commandRunner: TunnelCommandRunner
  readonly healthProbe: TunnelHealthProbe
}

const productionOptions: TunnelInstallerOptions = {
  paths: {
    directory: TUNNEL_CREDENTIAL_DIRECTORY,
    credential: TUNNEL_CREDENTIAL_PATH,
    state: TUNNEL_INSTALLER_STATE,
    privateKey: TUNNEL_PRIVATE_KEY,
    publicKey: TUNNEL_PUBLIC_KEY,
  },
  rootUid: 0,
  rootGid: 0,
  commandRunner: NodeTunnelCommandRunner,
  healthProbe: NodeTunnelHealthProbe,
}

interface InstallerState {
  readonly version: 1
  readonly organizationId: string
  readonly nodeId: string
  readonly tunnelId: string
  readonly operationId: string
  readonly deliveryId: string
  readonly revision: number
  readonly phase: 'installing' | 'active' | 'revoking' | 'revoked'
  readonly acknowledgedAt: string | null
}

const InstallerIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
)
const InstallerRevision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const InstallerTimestamp = Schema.String.check(Schema.isPattern(ISO_TIMESTAMP))
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  organizationId: InstallerIdentifier,
  nodeId: InstallerIdentifier,
  tunnelId: InstallerIdentifier,
  operationId: InstallerIdentifier,
  deliveryId: InstallerIdentifier,
  revision: InstallerRevision,
  phase: Schema.Literals(['installing', 'active', 'revoking', 'revoked']),
  acknowledgedAt: Schema.NullOr(InstallerTimestamp),
})

const safeError = (code: TunnelInstallerError['code']) => new TunnelInstallerError(code)
const mode = (value: number) => value & 0o7777
const scopeMatches = (left: InstallerState, right: TunnelCommand) =>
  left.organizationId === right.organizationId &&
  left.nodeId === right.nodeId &&
  left.tunnelId === right.tunnelId
const commandMatches = (left: InstallerState, right: TunnelCommand) =>
  scopeMatches(left, right) &&
  left.operationId === right.operationId &&
  left.deliveryId === right.deliveryId &&
  left.revision === right.revision
const acknowledgement = (
  command: TunnelCommand,
  status: 'active' | 'revoked',
  duplicate: boolean,
  now: string,
): TunnelCredentialAcknowledgement => ({
  organizationId: command.organizationId,
  nodeId: command.nodeId,
  tunnelId: command.tunnelId,
  operationId: command.operationId,
  deliveryId: command.deliveryId,
  revision: command.revision,
  status,
  duplicate,
  healthy: status === 'active',
  acknowledgedAt: now,
})

const validatePaths = (paths: TunnelInstallerPaths): void => {
  const directory = resolve(paths.directory)
  if (
    directory !== paths.directory ||
    paths.credential !== join(directory, 'credential') ||
    paths.state !== join(directory, 'installer-state.json') ||
    paths.privateKey !== join(directory, 'node-private-key') ||
    paths.publicKey !== join(directory, 'node-public-key')
  )
    throw safeError('unsafe_filesystem')
}

const assertDirectory = async (path: string, rootUid: number, rootGid: number): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe_filesystem')
  })
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== rootUid ||
    metadata.gid !== rootGid ||
    mode(metadata.mode) !== 0o700
  )
    throw safeError('unsafe_filesystem')
}

const assertPrivateFile = async (path: string, rootUid: number, rootGid: number): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe_filesystem')
  })
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== rootUid ||
    metadata.gid !== rootGid ||
    mode(metadata.mode) !== 0o600
  )
    throw safeError('unsafe_filesystem')
}

const assertReplaceable = async (path: string, rootUid: number, rootGid: number): Promise<void> => {
  try {
    const metadata = await lstat(path)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== rootUid ||
      metadata.gid !== rootGid ||
      mode(metadata.mode) !== 0o600
    )
      throw safeError('unsafe_filesystem')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const atomicWrite = async (
  path: string,
  bytes: Uint8Array | string,
  options: TunnelInstallerOptions,
  fileMode: 0o600,
): Promise<void> => {
  await assertDirectory(options.paths.directory, options.rootUid, options.rootGid)
  await assertReplaceable(path, options.rootUid, options.rootGid)
  const temporary = join(options.paths.directory, `.${randomUUID()}.tmp`)
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
      mode(metadata.mode) !== fileMode
    )
      throw safeError('unsafe_filesystem')
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(options.paths.directory)
  } catch (cause) {
    throw cause instanceof TunnelInstallerError ? cause : safeError('unsafe_filesystem')
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

const readState = async (options: TunnelInstallerOptions): Promise<InstallerState | null> => {
  try {
    const metadata = await lstat(options.paths.state)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== options.rootUid ||
      metadata.gid !== options.rootGid ||
      mode(metadata.mode) !== 0o600
    )
      throw safeError('unsafe_filesystem')
    const parsed: unknown = JSON.parse(await readFile(options.paths.state, 'utf8'))
    return await Schema.decodeUnknownPromise(StateSchema, { onExcessProperty: 'error' })(parsed)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (cause instanceof TunnelInstallerError) throw cause
    throw safeError('state_failed')
  }
}

const persistState = (options: TunnelInstallerOptions, state: InstallerState) =>
  atomicWrite(options.paths.state, `${JSON.stringify(state)}\n`, options, 0o600).catch(() => {
    throw safeError('state_failed')
  })

const readPrivateKey = async (options: TunnelInstallerOptions): Promise<string> => {
  await assertPrivateFile(options.paths.privateKey, options.rootUid, options.rootGid)
  return readFile(options.paths.privateKey, 'utf8').catch(() => {
    throw safeError('crypto_failed')
  })
}

export const provisionTunnelCredentialNodeKey = async (
  options: TunnelInstallerOptions = productionOptions,
): Promise<string> => {
  validatePaths(options.paths)
  let created = false
  try {
    await mkdir(options.paths.directory, { recursive: false, mode: 0o700 })
    created = true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw safeError('unsafe_filesystem')
  }
  if (created) {
    await chmod(options.paths.directory, 0o700)
    await chown(options.paths.directory, options.rootUid, options.rootGid)
  }
  await assertDirectory(options.paths.directory, options.rootUid, options.rootGid)
  try {
    await assertPrivateFile(options.paths.privateKey, options.rootUid, options.rootGid)
    await assertPrivateFile(options.paths.publicKey, options.rootUid, options.rootGid)
    return (await readFile(options.paths.publicKey, 'utf8')).trim()
  } catch (cause) {
    if (cause instanceof TunnelInstallerError && cause.code !== 'unsafe_filesystem') throw cause
    const pair = await Effect.runPromise(generateTunnelCredentialNodeKeyPair()).catch(() => {
      throw safeError('crypto_failed')
    })
    await atomicWrite(options.paths.privateKey, `${pair.privateKey}\n`, options, 0o600)
    await atomicWrite(options.paths.publicKey, `${pair.publicKey}\n`, options, 0o600)
    return pair.publicKey
  }
}

export interface RootTunnelInstaller {
  readonly publicKey: () => Promise<string>
  readonly execute: (command: unknown, now?: string) => Promise<TunnelInstallerExecutionProof>
}

export type TunnelInstallerExecutionProof =
  | (TunnelCredentialAcknowledgement & {
      readonly status: 'active'
      readonly owner: 'root'
      readonly group: 'root'
      readonly mode: '0600'
      readonly usedAtomicRename: true
      readonly fsyncedFile: true
      readonly fsyncedDirectory: true
      readonly activated: true
      readonly healthChecked: true
      readonly healthy: true
    })
  | (TunnelCredentialAcknowledgement & {
      readonly status: 'revoked'
      readonly removed: true
      readonly activationStopped: true
      readonly healthy: false
    })

const activeProof = (
  command: InstallCommand,
  duplicate: boolean,
  now: string,
): TunnelInstallerExecutionProof => ({
  ...acknowledgement(command, 'active', duplicate, now),
  status: 'active',
  owner: 'root',
  group: 'root',
  mode: '0600',
  usedAtomicRename: true,
  fsyncedFile: true,
  fsyncedDirectory: true,
  activated: true,
  healthChecked: true,
  healthy: true,
})

const revokedProof = (
  command: RevokeCommand,
  duplicate: boolean,
  now: string,
): TunnelInstallerExecutionProof => ({
  ...acknowledgement(command, 'revoked', duplicate, now),
  status: 'revoked',
  removed: true,
  activationStopped: true,
  healthy: false,
})

/** @internal Test seam. Production must use the fixed-path root entry point below. */
export const createRootTunnelInstallerWithOptions = (
  options: TunnelInstallerOptions,
): RootTunnelInstaller => {
  validatePaths(options.paths)
  let serialized = Promise.resolve()
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = serialized.then(operation, operation)
    serialized = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const install = async (
    command: InstallCommand,
    previous: InstallerState | null,
    now: string,
  ): Promise<TunnelInstallerExecutionProof> => {
    const pending: InstallerState = {
      version: 1,
      organizationId: command.organizationId,
      nodeId: command.nodeId,
      tunnelId: command.tunnelId,
      operationId: command.operationId,
      deliveryId: command.deliveryId,
      revision: command.revision,
      phase: 'installing',
      acknowledgedAt: null,
    }
    const privateKey = (await readPrivateKey(options)).trim()
    await Effect.runPromise(
      withOpenedTunnelCredential(privateKey, command, command.sealedCredential, (plaintext) =>
        Effect.tryPromise({
          try: async () => {
            if (previous?.phase !== 'installing') await persistState(options, pending)
            await atomicWrite(options.paths.credential, plaintext, options, 0o600)
          },
          catch: () => safeError('unsafe_filesystem'),
        }),
      ).pipe(Effect.mapError(() => safeError('crypto_failed'))),
    )
    await options.commandRunner.run(SYSTEMCTL, ['restart', 'cloudflared.service'])
    await options.commandRunner.run(SYSTEMCTL, ['is-active', '--quiet', 'cloudflared.service'])
    await options.healthProbe.ready().catch(() => {
      throw safeError('activation_failed')
    })
    const active: InstallerState = { ...pending, phase: 'active', acknowledgedAt: now }
    await persistState(options, active)
    return activeProof(command, previous?.phase === 'installing', now)
  }
  const revoke = async (
    command: RevokeCommand,
    previous: InstallerState,
    now: string,
  ): Promise<TunnelInstallerExecutionProof> => {
    const pending: InstallerState = {
      version: 1,
      organizationId: command.organizationId,
      nodeId: command.nodeId,
      tunnelId: command.tunnelId,
      operationId: command.operationId,
      deliveryId: command.deliveryId,
      revision: command.revision,
      phase: 'revoking',
      acknowledgedAt: null,
    }
    if (previous.phase !== 'revoking') await persistState(options, pending)
    await options.commandRunner.run(SYSTEMCTL, ['stop', 'cloudflared.service'])
    const activeState = await options.commandRunner.run(SYSTEMCTL, [
      'show',
      '--property=ActiveState',
      '--value',
      'cloudflared.service',
    ])
    if (activeState.trim() !== 'inactive') throw safeError('activation_failed')
    await assertReplaceable(options.paths.credential, options.rootUid, options.rootGid)
    await unlink(options.paths.credential).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw safeError('unsafe_filesystem')
    })
    await syncDirectory(options.paths.directory)
    const revoked: InstallerState = { ...pending, phase: 'revoked', acknowledgedAt: now }
    await persistState(options, revoked)
    return revokedProof(command, previous.phase === 'revoking', now)
  }

  return {
    publicKey: () => provisionTunnelCredentialNodeKey(options),
    execute: (input, now = new Date().toISOString()) =>
      exclusive(async () => {
        const command = await Schema.decodeUnknownPromise(TunnelCredentialCommandPayload, {
          onExcessProperty: 'error',
        })(input).catch(() => {
          throw safeError('invalid_request')
        })
        if (
          !ISO_TIMESTAMP.test(now) ||
          !Number.isFinite(Date.parse(now)) ||
          Date.parse(command.expiresAt) <= Date.parse(now)
        )
          throw safeError('invalid_request')
        await assertDirectory(options.paths.directory, options.rootUid, options.rootGid)
        const previous = await readState(options)
        if (previous !== null && !scopeMatches(previous, command)) throw safeError('scope_mismatch')
        if (previous !== null && previous.revision === command.revision) {
          if (!commandMatches(previous, command)) throw safeError('replay_rejected')
          const targetPhase = command.action === 'install' ? 'active' : 'revoked'
          if (previous.phase === targetPhase) {
            if (targetPhase === 'active') {
              await assertPrivateFile(options.paths.credential, options.rootUid, options.rootGid)
              await options.commandRunner.run(SYSTEMCTL, [
                'is-active',
                '--quiet',
                'cloudflared.service',
              ])
              await options.healthProbe.ready().catch(() => {
                throw safeError('activation_failed')
              })
            } else {
              await assertReplaceable(options.paths.credential, options.rootUid, options.rootGid)
              try {
                await lstat(options.paths.credential)
                throw safeError('activation_failed')
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
              }
              const activeState = await options.commandRunner.run(SYSTEMCTL, [
                'show',
                '--property=ActiveState',
                '--value',
                'cloudflared.service',
              ])
              if (activeState.trim() !== 'inactive') throw safeError('activation_failed')
            }
            return command.action === 'install'
              ? activeProof(command, true, previous.acknowledgedAt ?? now)
              : revokedProof(command, true, previous.acknowledgedAt ?? now)
          }
          return command.action === 'install'
            ? install(command, previous, now)
            : revoke(command, previous, now)
        }
        if (previous?.phase === 'installing' || previous?.phase === 'revoking')
          throw safeError('revision_conflict')
        if (
          command.expectedPriorRevision !== (previous?.revision ?? 0) ||
          (previous !== null && command.revision <= previous.revision)
        )
          throw safeError('revision_conflict')
        if (command.action === 'revoke' && previous?.phase !== 'active')
          throw safeError('revision_conflict')
        return command.action === 'install'
          ? install(command, previous, now)
          : revoke(command, previous!, now)
      }),
  }
}

export const createProductionRootTunnelInstaller = (): RootTunnelInstaller =>
  createRootTunnelInstallerWithOptions(productionOptions)

const ProofCommon = {
  organizationId: InstallerIdentifier,
  nodeId: InstallerIdentifier,
  tunnelId: InstallerIdentifier,
  operationId: InstallerIdentifier,
  deliveryId: InstallerIdentifier,
  revision: InstallerRevision,
  duplicate: Schema.Boolean,
  acknowledgedAt: InstallerTimestamp,
}
const decodeExecutionProof = Schema.decodeUnknownPromise(
  Schema.Union([
    Schema.Struct({
      ...ProofCommon,
      status: Schema.Literal('active'),
      owner: Schema.Literal('root'),
      group: Schema.Literal('root'),
      mode: Schema.Literal('0600'),
      usedAtomicRename: Schema.Literal(true),
      fsyncedFile: Schema.Literal(true),
      fsyncedDirectory: Schema.Literal(true),
      activated: Schema.Literal(true),
      healthChecked: Schema.Literal(true),
      healthy: Schema.Literal(true),
    }),
    Schema.Struct({
      ...ProofCommon,
      status: Schema.Literal('revoked'),
      removed: Schema.Literal(true),
      activationStopped: Schema.Literal(true),
      healthy: Schema.Literal(false),
    }),
  ]),
  { onExcessProperty: 'error' },
)

export const createTunnelInstallerHttpServer = (installer: RootTunnelInstaller): Server => {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === 'GET' && request.url === '/v1/public-key') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ publicKey: await installer.publicKey() }))
          return
        }
        if (request.method !== 'POST' || request.url !== '/v1/tunnel-credentials/execute')
          throw safeError('invalid_request')
        let size = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.byteLength
          if (size > MAX_REQUEST_BYTES) throw safeError('invalid_request')
          chunks.push(bytes)
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const result = await installer.execute(input)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"error":"tunnel_credential_operation_failed"}')
      }
    })()
  })
  server.maxHeadersCount = 16
  server.headersTimeout = 5_000
  server.requestTimeout = 40_000
  return server
}

const requestInstaller = (
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
): Promise<unknown> =>
  new Promise((resolveRequest, rejectRequest) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers:
          body === undefined
            ? undefined
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              },
        timeout: 45_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('error', () => rejectRequest(safeError('invalid_response')))
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > MAX_REQUEST_BYTES) response.destroy(safeError('invalid_response'))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw safeError('unavailable')
            resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            rejectRequest(safeError('invalid_response'))
          }
        })
      },
    )
    request.on('timeout', () => request.destroy(safeError('unavailable')))
    request.on('error', () => rejectRequest(safeError('unavailable')))
    request.end(body)
  })

export interface TunnelInstallerClient extends AtomicCredentialInstallerShape {
  readonly publicKey: () => Promise<string>
}

export const makeTunnelInstallerClient = (
  socketPath: string = TUNNEL_INSTALLER_SOCKET,
): TunnelInstallerClient => ({
  publicKey: async () => {
    const response = (await requestInstaller(socketPath, 'GET', '/v1/public-key')) as {
      publicKey?: unknown
    }
    if (
      typeof response.publicKey !== 'string' ||
      !response.publicKey.startsWith('rsa-oaep-spki-v1.')
    )
      throw safeError('invalid_response')
    return response.publicKey
  },
  install: (command) =>
    Effect.tryPromise({
      try: async () => {
        const response = await decodeExecutionProof(
          await requestInstaller(socketPath, 'POST', '/v1/tunnel-credentials/execute', command),
        )
        if (response.status !== 'active') throw safeError('invalid_response')
        return {
          organizationId: response.organizationId,
          nodeId: response.nodeId,
          tunnelId: response.tunnelId,
          operationId: response.operationId,
          deliveryId: response.deliveryId,
          revision: response.revision,
          owner: response.owner,
          group: response.group,
          mode: response.mode,
          usedAtomicRename: response.usedAtomicRename,
          fsyncedFile: response.fsyncedFile,
          fsyncedDirectory: response.fsyncedDirectory,
          activated: response.activated,
          healthChecked: response.healthChecked,
          healthy: response.healthy,
          alreadyInstalled: response.duplicate,
        }
      },
      catch: () =>
        new TunnelCredentialError({
          operation: 'tunnel.installer.client',
          code: 'install-failed',
          message: 'tunnel credential operation failed',
        }),
    }),
  revoke: (command) =>
    Effect.tryPromise({
      try: async () => {
        const response = await decodeExecutionProof(
          await requestInstaller(socketPath, 'POST', '/v1/tunnel-credentials/execute', command),
        )
        if (response.status !== 'revoked') throw safeError('invalid_response')
        return {
          removed: response.removed,
          activationStopped: response.activationStopped,
          alreadyRevoked: response.duplicate,
        }
      },
      catch: () =>
        new TunnelCredentialError({
          operation: 'tunnel.installer.client',
          code: 'revocation-failed',
          message: 'tunnel credential operation failed',
        }),
    }),
})

export async function serveProductionTunnelInstallerOnFd(fd: number): Promise<void> {
  if (fd !== 3 || process.getuid?.() !== 0) throw safeError('unsafe_filesystem')
  const socket = await lstat(TUNNEL_INSTALLER_SOCKET).catch(() => {
    throw safeError('unsafe_filesystem')
  })
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== 0 ||
    ![0o600, 0o660].includes(mode(socket.mode))
  )
    throw safeError('unsafe_filesystem')
  const installer = createProductionRootTunnelInstaller()
  await installer.publicKey()
  const server = createTunnelInstallerHttpServer(installer)
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

import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CommandResult } from '@gridora/agent-protocol'
import { decodeAgentCommand } from '@gridora/agent-protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import { AgentError } from './errors.js'
import type { AgentIdentity } from './validation.js'

export interface RegistrationRequest extends AgentIdentity {
  readonly agentVersion: string
  readonly providerInstanceId: string
  /** RSA-OAEP SPKI returned by the root-only tunnel credential installer. */
  readonly installerPublicKey: string
  readonly registrationToken: string
}
export interface RegistrationResponse {
  readonly nodeCredential: string
  readonly credentialId: string
  readonly credentialVersion: number
  readonly sessionVersion: number
  readonly registrationTokenConsumed: true
}

export interface NodeAuthentication {
  readonly nodeCredential: string
  readonly credentialId: string
  readonly credentialVersion: number
  readonly sessionVersion: number
}

export type AcquiredNodeAuthentication =
  | { readonly kind: 'current'; readonly authentication: NodeAuthentication }
  | { readonly kind: 'legacy'; readonly nodeCredential: string }

export class AgentTransport extends Context.Service<
  AgentTransport,
  {
    readonly register: (
      request: RegistrationRequest,
    ) => Effect.Effect<RegistrationResponse, AgentError>
    readonly poll: (
      credential: string,
      identity: AgentIdentity,
      waitSeconds: number,
    ) => Effect.Effect<unknown, AgentError>
    readonly acknowledge: (
      credential: string,
      identity: AgentIdentity,
      result: CommandResult,
    ) => Effect.Effect<void, AgentError>
    readonly revokeRegistrationToken: (
      credential: string,
      identity: AgentIdentity,
      registrationToken: string,
    ) => Effect.Effect<void, AgentError>
  }
>()('gridora/agent/Transport') {}

const RegistrationResponseSchema = Schema.Struct({
  nodeCredential: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  credentialId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  credentialVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sessionVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  registrationTokenConsumed: Schema.Literal(true),
})

const NodeAuthenticationFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  nodeCredential: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  credentialId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  credentialVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sessionVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
const InstallerPublicKey = Schema.String.check(
  Schema.isMinLength(512),
  Schema.isMaxLength(2048),
  Schema.isPattern(/^rsa-oaep-spki-v1\.[A-Za-z0-9_-]+$/),
)
const RegistrationComplete = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  credentialId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  credentialVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sessionVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})

const transportFailure = (message: string) => new AgentError({ code: 'execution-failed', message })

const readSecretFile = async (path: string): Promise<string> => {
  const metadata = await lstat(path)
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
    throw new Error(`secret file ${path} does not have the required private mode`)
  if (process.getuid !== undefined && metadata.uid !== process.getuid())
    throw new Error(`secret file ${path} is not owned by the agent user`)
  return (await readFile(path, 'utf8')).trim()
}

export const validateControlPlaneUrl = (
  controlPlaneUrl: string,
  expectedHost: string,
  allowLoopbackHttp: boolean,
): URL => {
  const url = new URL(controlPlaneUrl)
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.hostname !== expectedHost)
    throw new Error('controlPlaneUrl host does not match expectedControlPlaneHost')
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:'))
    throw new Error('controlPlaneUrl must use HTTPS (except explicit loopback development)')
  if (url.username !== '' || url.password !== '')
    throw new Error('controlPlaneUrl must not contain credentials')
  return url
}

export const FetchAgentTransport = (
  controlPlaneUrl: string,
  expectedHost: string,
  allowLoopbackHttp = false,
) => {
  const origin = validateControlPlaneUrl(controlPlaneUrl, expectedHost, allowLoopbackHttp)
  const call = (path: string, init: RequestInit): Effect.Effect<Response, AgentError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(new URL(path, origin), {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        })
        if (!response.ok) throw new Error(`control plane returned ${response.status}`)
        return response
      },
      catch: (cause) => transportFailure(`control-plane request failed: ${String(cause)}`),
    })
  return Layer.succeed(AgentTransport, {
    register: (request) =>
      call('/v1/agent/registrations/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) => transportFailure(`invalid registration response: ${String(cause)}`),
          }),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(RegistrationResponseSchema)),
        Effect.mapError((cause) =>
          cause instanceof AgentError
            ? cause
            : transportFailure(`registration response failed validation: ${String(cause)}`),
        ),
      ),
    poll: (credential, identity, waitSeconds) =>
      call(
        `/v1/agent/nodes/${encodeURIComponent(identity.nodeId)}/commands?waitSeconds=${waitSeconds}`,
        { headers: { authorization: `Bearer ${credential}` } },
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 204
            ? Effect.succeed(undefined)
            : Effect.tryPromise({
                try: () => response.json(),
                catch: (cause) => transportFailure(`invalid command response: ${String(cause)}`),
              }),
        ),
      ),
    acknowledge: (credential, identity, result) =>
      call(
        `/v1/agent/nodes/${encodeURIComponent(identity.nodeId)}/commands/${encodeURIComponent(result.commandId)}/result`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        },
      ).pipe(Effect.asVoid),
    revokeRegistrationToken: (credential, identity, registrationToken) =>
      call('/v1/agent/registrations/revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: identity.organizationId,
          nodeId: identity.nodeId,
          registrationToken,
        }),
      }).pipe(Effect.asVoid),
  })
}

export interface CredentialBootstrapConfig extends AgentIdentity {
  readonly agentVersion: string
  readonly providerInstanceId: string
  readonly installerPublicKey: string
  readonly stateDirectory: string
  readonly registrationTokenFile: string
}

export const nodeCredentialPath = (stateDirectory: string): string =>
  `${stateDirectory}/node-credential`
export const registrationCompletePath = (stateDirectory: string): string =>
  `${stateDirectory}/registration-complete`

export const acquireNodeAuthentication = (
  config: CredentialBootstrapConfig,
): Effect.Effect<AcquiredNodeAuthentication, AgentError, AgentTransport> =>
  Effect.gen(function* () {
    const path = nodeCredentialPath(config.stateDirectory)
    const existing = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readSecretFile(path)
        } catch (cause) {
          if (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === 'ENOENT'
          )
            return undefined
          throw cause
        }
      },
      catch: (cause) => transportFailure(`could not read node credential: ${String(cause)}`),
    })
    if (existing !== undefined) {
      const decoded = yield* Effect.result(
        Effect.try(() => JSON.parse(existing) as unknown).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(NodeAuthenticationFile, { onExcessProperty: 'error' }),
          ),
        ),
      )
      const authentication: AcquiredNodeAuthentication | undefined =
        decoded._tag === 'Success' &&
        decoded.success.organizationId === config.organizationId &&
        decoded.success.nodeId === config.nodeId
          ? {
              kind: 'current',
              authentication: {
                nodeCredential: decoded.success.nodeCredential,
                credentialId: decoded.success.credentialId,
                credentialVersion: decoded.success.credentialVersion,
                sessionVersion: decoded.success.sessionVersion,
              },
            }
          : existing.length >= 32 && existing.length <= 512 && !existing.trimStart().startsWith('{')
            ? { kind: 'legacy', nodeCredential: existing }
            : undefined
      if (authentication === undefined)
        return yield* Effect.fail(transportFailure('persisted node authentication is invalid'))
      const staleToken = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readSecretFile(config.registrationTokenFile)
          } catch (cause) {
            if (
              typeof cause === 'object' &&
              cause !== null &&
              'code' in cause &&
              cause.code === 'ENOENT'
            )
              return undefined
            throw cause
          }
        },
        catch: (cause) =>
          transportFailure(`could not inspect stale registration token: ${String(cause)}`),
      })
      if (staleToken !== undefined) {
        const transport = yield* AgentTransport
        yield* transport.revokeRegistrationToken(
          authentication.kind === 'current'
            ? authentication.authentication.nodeCredential
            : authentication.nodeCredential,
          config,
          staleToken,
        )
        yield* removeRegistrationToken(config.registrationTokenFile)
        if (authentication.kind === 'current')
          yield* persistRegistrationComplete(config, authentication.authentication)
      } else if (authentication.kind === 'current') {
        yield* ensureRegistrationComplete(config, authentication.authentication)
      }
      return authentication
    }
    const registrationToken = yield* Effect.tryPromise({
      try: () => readSecretFile(config.registrationTokenFile),
      catch: (cause) =>
        transportFailure(`one-time registration token is unavailable: ${String(cause)}`),
    })
    if (registrationToken.length < 32)
      return yield* Effect.fail(transportFailure('one-time registration token is invalid'))
    const installerPublicKey = yield* Schema.decodeUnknownEffect(InstallerPublicKey)(
      config.installerPublicKey,
    ).pipe(Effect.mapError(() => transportFailure('installer public key is invalid')))
    const transport = yield* AgentTransport
    const registered = yield* transport.register({
      organizationId: config.organizationId,
      nodeId: config.nodeId,
      agentVersion: config.agentVersion,
      providerInstanceId: config.providerInstanceId,
      installerPublicKey,
      registrationToken,
    })
    // Persisting is supplied by the runtime's crash-safe secret writer before token deletion.
    yield* persistNodeAuthentication(path, registered, config)
    yield* removeRegistrationToken(config.registrationTokenFile)
    yield* persistRegistrationComplete(config, registered)
    return {
      kind: 'current' as const,
      authentication: {
        nodeCredential: registered.nodeCredential,
        credentialId: registered.credentialId,
        credentialVersion: registered.credentialVersion,
        sessionVersion: registered.sessionVersion,
      },
    }
  })

const removeRegistrationToken = (path: string): Effect.Effect<void, AgentError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await rm(path)
      } catch (cause) {
        if (
          typeof cause !== 'object' ||
          cause === null ||
          !('code' in cause) ||
          cause.code !== 'ENOENT'
        )
          throw cause
      }
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    },
    catch: () => transportFailure('registration token could not be removed durably'),
  })

const registrationCompleteRecord = (
  config: CredentialBootstrapConfig,
  authentication: NodeAuthentication,
) => ({
  schemaVersion: 1 as const,
  organizationId: config.organizationId,
  nodeId: config.nodeId,
  credentialId: authentication.credentialId,
  credentialVersion: authentication.credentialVersion,
  sessionVersion: authentication.sessionVersion,
})

const persistRegistrationComplete = (
  config: CredentialBootstrapConfig,
  authentication: NodeAuthentication,
): Effect.Effect<void, AgentError> =>
  Effect.tryPromise({
    try: async () => {
      const path = registrationCompletePath(config.stateDirectory)
      const directory = dirname(path)
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(
            `${JSON.stringify(registrationCompleteRecord(config, authentication))}\n`,
            'utf8',
          )
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, path)
        const parent = await open(directory, 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      } catch (cause) {
        await rm(temporary, { force: true })
        throw cause
      }
    },
    catch: () => transportFailure('registration completion could not be persisted'),
  })

const ensureRegistrationComplete = (
  config: CredentialBootstrapConfig,
  authentication: NodeAuthentication,
): Effect.Effect<void, AgentError> =>
  Effect.tryPromise({
    try: async () => {
      const path = registrationCompletePath(config.stateDirectory)
      try {
        const metadata = await lstat(path)
        if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
          throw new Error('registration completion metadata is invalid')
        if (process.getuid !== undefined && metadata.uid !== process.getuid())
          throw new Error('registration completion owner is invalid')
        const decoded = await Schema.decodeUnknownPromise(RegistrationComplete, {
          onExcessProperty: 'error',
        })(JSON.parse(await readFile(path, 'utf8')) as unknown)
        const expected = registrationCompleteRecord(config, authentication)
        if (
          decoded.organizationId !== expected.organizationId ||
          decoded.nodeId !== expected.nodeId ||
          decoded.credentialId !== expected.credentialId ||
          decoded.credentialVersion !== expected.credentialVersion ||
          decoded.sessionVersion !== expected.sessionVersion
        )
          throw new Error('registration completion coordinates are invalid')
        return true
      } catch (cause) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        )
          return false
        throw cause
      }
    },
    catch: () => transportFailure('registration completion could not be validated'),
  }).pipe(
    Effect.flatMap((exists) =>
      exists ? Effect.void : persistRegistrationComplete(config, authentication),
    ),
  )

export const acquireNodeCredential = (
  config: CredentialBootstrapConfig,
): Effect.Effect<string, AgentError, AgentTransport> =>
  acquireNodeAuthentication(config).pipe(
    Effect.map((authentication) =>
      authentication.kind === 'current'
        ? authentication.authentication.nodeCredential
        : authentication.nodeCredential,
    ),
  )

const persistNodeAuthentication = (
  path: string,
  authentication: RegistrationResponse,
  identity: AgentIdentity,
): Effect.Effect<void, AgentError> =>
  Effect.tryPromise({
    try: async () => {
      const { randomUUID } = await import('node:crypto')
      const { mkdir, open, rename, rm: remove } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const directory = dirname(path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(
            `${JSON.stringify({
              schemaVersion: 1,
              organizationId: identity.organizationId,
              nodeId: identity.nodeId,
              nodeCredential: authentication.nodeCredential,
              credentialId: authentication.credentialId,
              credentialVersion: authentication.credentialVersion,
              sessionVersion: authentication.sessionVersion,
            })}\n`,
            'utf8',
          )
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, path)
        const parent = await open(directory, 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      } catch (cause) {
        await remove(temporary, { force: true })
        throw cause
      }
    },
    catch: (cause) => transportFailure(`could not persist node credential: ${String(cause)}`),
  })

export const rejectedResult = (
  input: unknown,
  error: AgentError,
  completedAt: string,
): Effect.Effect<CommandResult | undefined> =>
  decodeAgentCommand(input).pipe(
    Effect.map((command) => ({
      commandId: command.commandId,
      operationId: command.operationId,
      status: 'rejected' as const,
      revision: command.expectedPriorRevision,
      code: error.code,
      message: error.message,
      duplicate: false,
      completedAt,
    })),
    Effect.catch(() => Effect.succeed(undefined)),
  )

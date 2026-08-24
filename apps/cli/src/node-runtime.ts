import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { createGridoraClient, GridoraClientError } from '@gridora/generated-client'
import { Effect, Layer, Schema } from 'effect'
import { createLoginStart, type OAuthDiscovery } from './auth.js'
import {
  GridoraApi,
  type ApiRequest,
  type ApiResponse,
  type LiveLogStreamEvent,
  type LiveLogStreamRequest,
} from './client.js'
import { type ParsedCommand, parseCommand } from './commands.js'
import { CliError, errorEnvelope, ExitCode } from './errors.js'
import { renderOutput } from './output.js'
import { type CliProfile, ProfileStore, validateProfile } from './profile.js'
import { CliFiles, executeRemoteCommand } from './runner.js'

interface Tokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
}
const memoryTokens = new Map<string, { readonly token: string; readonly expiresAt: number }>()
export const accessGatewayHeaders = (token: string): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${token}`,
})
export const bootstrapThroughAccess = async (
  origin: string,
  token: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(new URL('/v1/auth/bootstrap', secureUrl(origin)), {
    headers: accessGatewayHeaders(token),
    redirect: 'error',
  })
  const data = (await response.json()) as Record<string, unknown>
  if (!response.ok)
    throw failure(
      'access_bootstrap_failed',
      'Cloudflare Access rejected the CLI token; log in again',
      ExitCode.authentication,
      { status: response.status },
    )
  return data
}
const failure = (code: string, message: string, exitCode: number, details?: unknown) =>
  new CliError({ code, message, exitCode, ...(details === undefined ? {} : { details }) })
const exec = (file: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, [...args], { encoding: 'utf8' }, (error, output) =>
      error ? reject(error) : resolve(output.trim()),
    ),
  )
const execInput = (file: string, args: ReadonlyArray<string>, input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { encoding: 'utf8' }, (error, output) =>
      error ? reject(error) : resolve(output.trim()),
    )
    child.stdin?.end(input)
  })
const isMissingKeychainItem = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 44
const isMissingSecretServiceItem = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 1
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const pathFor = (name: string): string => {
  if (!profileNamePattern.test(name))
    throw failure('invalid_profile', 'profile name is invalid', ExitCode.usage)
  return join(
    process.env.GRIDORA_CONFIG_DIR ?? join(homedir(), '.config', 'gridora'),
    'profiles',
    `${name}.json`,
  )
}
const loadProfile = async (name: string): Promise<CliProfile | undefined> => {
  try {
    const profile = await Effect.runPromise(
      validateProfile(JSON.parse(await readFile(pathFor(name), 'utf8')) as unknown),
    )
    secureUrl(profile.apiOrigin)
    if (profile.authIssuer !== undefined) secureUrl(profile.authIssuer)
    return profile
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT')
      return undefined
    throw cause
  }
}
const saveProfile = async (profile: CliProfile): Promise<void> => {
  const path = pathFor(profile.name)
  const temporaryPath = `${path}.${randomBytes(12).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  try {
    await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (cause) {
    await rm(temporaryPath, { force: true })
    throw cause
  }
}
interface CredentialProcess {
  readonly run: (file: string, args: ReadonlyArray<string>) => Promise<string>
  readonly runWithInput: (
    file: string,
    args: ReadonlyArray<string>,
    input: string,
  ) => Promise<string>
}

export const makeSystemCredentialStore = (
  platform: NodeJS.Platform,
  credentialProcess: CredentialProcess,
) => {
  const requireSafeProfile = (profile: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(profile))
      throw failure('invalid_profile', 'profile name is not keychain-safe', ExitCode.usage)
  }
  const unavailable = () =>
    failure(
      'keychain_unavailable',
      platform === 'linux'
        ? 'Secret Service is required through secret-tool; plaintext fallback is forbidden'
        : 'An operating-system credential store is required; plaintext fallback is forbidden',
      ExitCode.authentication,
    )
  return {
    get: async (profile: string): Promise<string | undefined> => {
      requireSafeProfile(profile)
      if (platform === 'darwin') {
        try {
          const encoded = await credentialProcess.run('/usr/bin/security', [
            'find-generic-password',
            '-s',
            'dev.gridora.cli',
            '-a',
            profile,
            '-w',
          ])
          return Buffer.from(encoded, 'base64').toString('utf8')
        } catch (cause) {
          if (isMissingKeychainItem(cause)) return undefined
          throw failure(
            'keychain_read_failed',
            'macOS Keychain could not read the Gridora credential',
            ExitCode.authentication,
          )
        }
      }
      if (platform === 'linux') {
        try {
          return await credentialProcess.run('secret-tool', [
            'lookup',
            'service',
            'dev.gridora.cli',
            'account',
            profile,
          ])
        } catch (cause) {
          if (isMissingSecretServiceItem(cause)) return undefined
          throw failure(
            'keychain_read_failed',
            'Secret Service could not read the Gridora credential',
            ExitCode.authentication,
          )
        }
      }
      throw unavailable()
    },
    set: async (profile: string, token: string): Promise<void> => {
      requireSafeProfile(profile)
      if (platform === 'darwin') {
        const encoded = Buffer.from(token, 'utf8').toString('base64')
        try {
          await credentialProcess.runWithInput(
            '/usr/bin/security',
            ['-i'],
            `add-generic-password -U -s dev.gridora.cli -a ${profile} -w ${encoded}\n`,
          )
          return
        } catch {
          throw failure(
            'keychain_write_failed',
            'macOS Keychain could not store the Gridora credential',
            ExitCode.authentication,
          )
        }
      }
      if (platform === 'linux') {
        try {
          await credentialProcess.runWithInput(
            'secret-tool',
            ['store', '--label=Gridora CLI', 'service', 'dev.gridora.cli', 'account', profile],
            token,
          )
          return
        } catch {
          throw failure(
            'keychain_write_failed',
            'Secret Service could not store the Gridora credential',
            ExitCode.authentication,
          )
        }
      }
      throw unavailable()
    },
    remove: async (profile: string): Promise<void> => {
      requireSafeProfile(profile)
      if (platform === 'darwin') {
        try {
          await credentialProcess.run('/usr/bin/security', [
            'delete-generic-password',
            '-s',
            'dev.gridora.cli',
            '-a',
            profile,
          ])
          return
        } catch (cause) {
          if (isMissingKeychainItem(cause)) return
          throw failure(
            'keychain_delete_failed',
            'macOS Keychain could not delete the Gridora credential',
            ExitCode.authentication,
          )
        }
      }
      if (platform === 'linux') {
        try {
          await credentialProcess.run('secret-tool', [
            'clear',
            'service',
            'dev.gridora.cli',
            'account',
            profile,
          ])
          return
        } catch (cause) {
          if (isMissingSecretServiceItem(cause)) return
          throw failure(
            'keychain_delete_failed',
            'Secret Service could not delete the Gridora credential',
            ExitCode.authentication,
          )
        }
      }
      throw unavailable()
    },
  }
}

const keychain = makeSystemCredentialStore(process.platform, {
  run: exec,
  runWithInput: execInput,
})
const secureUrl = (value: string, expectedOrigin?: string): URL => {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  const allowLoopback = process.env.GRIDORA_ALLOW_LOOPBACK_HTTP === '1'
  if (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:'))
    throw new Error('OAuth/API URL must use HTTPS except explicit loopback development')
  if (url.username !== '' || url.password !== '')
    throw new Error('OAuth/API URL must not contain credentials')
  if (expectedOrigin !== undefined && url.origin !== expectedOrigin)
    throw new Error('OAuth endpoint origin does not match the discovered issuer')
  return url
}

export const discoverOAuth = async (
  origin: string,
  expectedIssuer?: string,
): Promise<OAuthDiscovery> => {
  const api = secureUrl(origin)
  const response = await fetch(new URL('/.well-known/oauth-authorization-server', api), {
    redirect: 'error',
  })
  const data = (await response.json()) as Record<string, unknown>
  if (
    !response.ok ||
    typeof data.issuer !== 'string' ||
    typeof data.authorization_endpoint !== 'string' ||
    typeof data.token_endpoint !== 'string'
  )
    throw new Error('OAuth discovery failed')
  const issuer = secureUrl(data.issuer)
  const allowedIssuer = expectedIssuer === undefined ? undefined : secureUrl(expectedIssuer)
  if (allowedIssuer !== undefined && issuer.toString() !== allowedIssuer.toString())
    throw new Error('OAuth discovery issuer does not match the configured issuer')
  const authorizationEndpoint = secureUrl(data.authorization_endpoint, issuer.origin)
  const tokenEndpoint = secureUrl(data.token_endpoint, issuer.origin)
  const registrationEndpoint =
    typeof data.registration_endpoint === 'string'
      ? secureUrl(data.registration_endpoint, issuer.origin).toString()
      : undefined
  const revocationEndpoint =
    typeof data.revocation_endpoint === 'string'
      ? secureUrl(data.revocation_endpoint, issuer.origin).toString()
      : undefined
  return {
    issuer: issuer.toString(),
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
  }
}

export const revokeRefreshToken = async (input: {
  readonly apiOrigin: string
  readonly authIssuer: string
  readonly clientId: string
  readonly refreshToken: string
}): Promise<void> => {
  const metadata = await discoverOAuth(input.apiOrigin, input.authIssuer)
  if (metadata.revocationEndpoint === undefined)
    throw new Error('OAuth provider has no revocation endpoint; use --local-only to forget locally')
  const response = await fetch(metadata.revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: input.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: input.clientId,
    }),
    redirect: 'error',
  })
  if (!response.ok)
    throw failure(
      'oauth_revocation_failed',
      'the refresh token could not be revoked',
      ExitCode.authentication,
      { status: response.status },
    )
}
export const exchangeTokens = async (
  endpoint: string,
  body: URLSearchParams,
  fallbackRefreshToken?: string,
): Promise<Tokens> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'error',
  })
  const data = (await response.json()) as Record<string, unknown>
  if (!response.ok)
    throw failure(
      'oauth_token_rejected',
      'the OAuth grant is invalid or expired; log in again',
      ExitCode.authentication,
      { status: response.status },
    )
  if (
    typeof data.access_token !== 'string' ||
    (typeof data.refresh_token !== 'string' && fallbackRefreshToken === undefined)
  )
    throw failure(
      'oauth_token_response_invalid',
      'the OAuth server returned an invalid token response',
      ExitCode.unavailable,
    )
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === 'string' ? data.refresh_token : (fallbackRefreshToken ?? ''),
    expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 300) * 1000,
  }
}
interface LoopbackCallback {
  readonly redirectUri: string
  readonly code: Promise<string>
  readonly close: () => void
}

const callback = (state: string, timeoutMs = 300_000): Promise<LoopbackCallback> =>
  new Promise((ready, reject) => {
    let accept: (code: string) => void = () => undefined
    let deny: (error: Error) => void = () => undefined
    const code = new Promise<string>((resolve, rejectCode) => {
      accept = resolve
      deny = rejectCode
    })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = () => {
      if (timer !== undefined) clearTimeout(timer)
      server.close()
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const value = url.searchParams.get('code')
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('Not found.')
        return
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400).end('Gridora login state did not match. Return to the CLI.')
        return
      }
      const oauthError = url.searchParams.get('error')
      if (oauthError !== null || value === null) {
        response.writeHead(400).end('Gridora login failed. Return to the CLI.')
        if (!settled) {
          settled = true
          deny(
            new Error(
              oauthError === null ? 'OAuth callback has no code' : `OAuth failed: ${oauthError}`,
            ),
          )
        }
        close()
        return
      }
      response.writeHead(200).end('Gridora login complete. You can close this window.')
      if (!settled) {
        settled = true
        accept(value)
      }
      close()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('loopback bind failed'))
      else {
        timer = setTimeout(() => {
          if (!settled) {
            settled = true
            deny(new Error('OAuth callback timed out'))
          }
          close()
        }, timeoutMs)
        timer.unref()
        ready({ redirectUri: `http://127.0.0.1:${address.port}/callback`, code, close })
      }
    })
  })

type BootstrapOrganization = Readonly<Record<string, unknown>>

export const bootstrapOrganizationIdentifier = (summary: BootstrapOrganization): string => {
  const organization = summary.organization
  if (typeof organization === 'string' && organizationIdentifierPattern.test(organization))
    return organization
  if (typeof organization === 'object' && organization !== null) {
    const record = organization as Record<string, unknown>
    const candidate =
      typeof record.slug === 'string'
        ? record.slug
        : typeof record.id === 'string'
          ? record.id
          : undefined
    if (candidate !== undefined && organizationIdentifierPattern.test(candidate)) return candidate
  }
  throw new Error('bootstrap organization summary is invalid')
}

const organizationIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export const selectBootstrapOrganization = (
  organizations: ReadonlyArray<BootstrapOrganization>,
  preferred: string | undefined,
): BootstrapOrganization | undefined => {
  if (preferred === undefined) return organizations.length === 1 ? organizations[0] : undefined
  const selected = organizations.find((summary) => {
    const organization = summary.organization
    if (typeof organization === 'string') return organization === preferred
    if (typeof organization !== 'object' || organization === null) return false
    const record = organization as Record<string, unknown>
    return record.id === preferred || record.slug === preferred
  })
  if (selected === undefined)
    throw new Error('the selected organization is not an active membership')
  return selected
}

const login = async (
  name: string,
  origin: string,
  expectedIssuer: string | undefined,
  preferredOrganization: string | undefined,
): Promise<unknown> => {
  const metadata = await discoverOAuth(origin, expectedIssuer)
  const state = randomBytes(24).toString('base64url')
  const listener = await callback(state)
  let clientId = 'gridora-cli'
  let issued: Tokens
  try {
    if (metadata.registrationEndpoint !== undefined) {
      const response = await fetch(metadata.registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Gridora CLI',
          redirect_uris: [listener.redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          resource: secureUrl(origin).origin,
        }),
        redirect: 'error',
      })
      const data = (await response.json()) as Record<string, unknown>
      if (!response.ok || typeof data.client_id !== 'string' || data.client_id.length === 0)
        throw failure(
          'oauth_registration_failed',
          'Cloudflare Access did not register the CLI public client',
          response.status >= 500 ? ExitCode.unavailable : ExitCode.authentication,
          { status: response.status },
        )
      clientId = data.client_id
    }
    const start = createLoginStart({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId,
      redirectUri: listener.redirectUri,
      resource: secureUrl(origin).origin,
      state,
    })
    try {
      await exec('/usr/bin/open', [start.authorizationUrl])
    } catch {
      process.stderr.write(`Open this URL:\n${start.authorizationUrl}\n`)
    }
    issued = await exchangeTokens(
      metadata.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: await listener.code,
        client_id: clientId,
        code_verifier: start.verifier,
        redirect_uri: listener.redirectUri,
        resource: secureUrl(origin).origin,
      }),
    )
  } finally {
    listener.close()
  }
  const data = await bootstrapThroughAccess(origin, issued.accessToken)
  const organizations = Array.isArray(data.organizations)
    ? (data.organizations as ReadonlyArray<Record<string, unknown>>)
    : []
  let member = selectBootstrapOrganization(organizations, preferredOrganization)
  if (member === undefined && organizations.length > 1 && process.stdin.isTTY) {
    organizations.forEach((summary, index) =>
      process.stdout.write(`${index + 1}. ${bootstrapOrganizationIdentifier(summary)}\n`),
    )
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    const selected = Number(await readline.question('Select organization: ')) - 1
    readline.close()
    if (!Number.isSafeInteger(selected) || organizations[selected] === undefined)
      throw new Error('organization selection is invalid')
    member = organizations[selected]
  }
  if (member === undefined && organizations.length > 1)
    throw new Error(
      'multiple organizations are available; pass --organization in non-interactive mode',
    )
  const activeOrganization =
    member === undefined ? undefined : bootstrapOrganizationIdentifier(member)
  await keychain.set(name, issued.refreshToken)
  try {
    await saveProfile({
      name,
      apiOrigin: secureUrl(origin).origin,
      clientId,
      authIssuer: metadata.issuer,
      ...(activeOrganization === undefined ? {} : { activeOrganization }),
    })
  } catch (cause) {
    await keychain.remove(name)
    throw cause
  }
  memoryTokens.set(name, { token: issued.accessToken, expiresAt: issued.expiresAt })
  return { identityId: data.identityId ?? null, activeOrganization: activeOrganization ?? null }
}
const accessToken = async (profile: CliProfile): Promise<string> => {
  const cached = memoryTokens.get(profile.name)
  if (cached !== undefined && cached.expiresAt > Date.now() + 30_000) return cached.token
  const refresh = await keychain.get(profile.name)
  if (refresh === undefined || profile.clientId === undefined)
    throw failure('not_authenticated', 'run gridora auth login', ExitCode.authentication)
  if (profile.authIssuer === undefined)
    throw failure(
      'issuer_missing',
      'OAuth issuer is not pinned; log in again',
      ExitCode.authentication,
    )
  const metadata = await discoverOAuth(profile.apiOrigin, profile.authIssuer)
  const issued = await exchangeTokens(
    metadata.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: profile.clientId,
      resource: profile.apiOrigin,
    }),
    refresh,
  )
  await keychain.set(profile.name, issued.refreshToken)
  memoryTokens.set(profile.name, { token: issued.accessToken, expiresAt: issued.expiresAt })
  return issued.accessToken
}

const liveLogMaximumEvents = 10_000
const liveLogMaximumFrameBytes = 64 * 1024
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const liveLogEntryMatches = (
  value: unknown,
  input: LiveLogStreamRequest,
  organizationId: string,
  streamEpoch: string,
): LiveLogStreamEvent | undefined => {
  const frame = asRecord(value)
  const entry = frame === undefined ? undefined : asRecord(frame.entry)
  if (
    frame?.type !== 'log' ||
    entry === undefined ||
    typeof frame.sequence !== 'number' ||
    !Number.isSafeInteger(frame.sequence) ||
    frame.sequence < 1 ||
    frame.organizationId !== organizationId ||
    frame.serverId !== input.serverId ||
    frame.streamEpoch !== streamEpoch ||
    frame.cursor !== `${encodeURIComponent(streamEpoch)}.${frame.sequence}` ||
    entry.sequence !== frame.sequence ||
    entry.organizationId !== organizationId ||
    entry.serverId !== input.serverId ||
    typeof entry.timestamp !== 'string' ||
    typeof entry.component !== 'string' ||
    typeof entry.level !== 'string'
  )
    return undefined
  if (input.component !== undefined && entry.component !== input.component) return undefined
  if (input.level !== undefined && entry.level !== input.level) return undefined
  if (input.from !== undefined && entry.timestamp < input.from) return undefined
  if (input.to !== undefined && entry.timestamp > input.to) return undefined
  return { sequence: frame.sequence, entry }
}
const frameText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > liveLogMaximumFrameBytes) return undefined
    return new TextDecoder().decode(value)
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > liveLogMaximumFrameBytes) return undefined
    return new TextDecoder().decode(value)
  }
  return undefined
}

/**
 * Consumes exactly one short-lived ticket. Deliberately do not retry an
 * upgrade: a retry would be indistinguishable from a ticket replay.
 */
export const collectLiveLogs = async (
  profile: CliProfile,
  request: (input: ApiRequest) => Promise<ApiResponse>,
  input: LiveLogStreamRequest,
): Promise<ReadonlyArray<LiveLogStreamEvent>> => {
  const ticketResponse = await request({
    method: 'POST',
    path: `/v1/game-servers/${encodeURIComponent(input.serverId)}/logs/stream/ticket`,
    organizationScoped: true,
    organization: input.organization,
  })
  const ticketBody = asRecord(ticketResponse.data)
  const ticket = ticketBody?.ticket
  const expiresAt = ticketBody?.expiresAt
  const organizationId = ticketBody?.organizationId
  const streamEpoch = ticketBody?.streamEpoch
  if (
    typeof ticket !== 'string' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    typeof organizationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) ||
    typeof streamEpoch !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(streamEpoch)
  )
    throw failure(
      'live_log_ticket_invalid',
      'the API returned an invalid live log ticket',
      ExitCode.unavailable,
    )
  const client = createGridoraClient({ baseUrl: secureUrl(profile.apiOrigin).origin })
  const url = client.liveLogWebSocketUrl(input.organization, input.serverId, ticket)
  const token = await accessToken(profile)
  const WebSocketWithHeaders = globalThis.WebSocket as unknown as new (
    url: string,
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ) => WebSocket
  return new Promise<ReadonlyArray<LiveLogStreamEvent>>((resolve, reject) => {
    const events: LiveLogStreamEvent[] = []
    let settled = false
    let opened = false
    const settle = (result: ReadonlyArray<LiveLogStreamEvent> | Error) => {
      if (settled) return
      settled = true
      clearTimeout(openTimeout)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    let socket: WebSocket
    try {
      socket = new WebSocketWithHeaders(url, { headers: accessGatewayHeaders(token) })
    } catch (cause) {
      settle(
        failure(
          'live_log_connect_failed',
          'the live log WebSocket could not be opened',
          ExitCode.unavailable,
          String(cause),
        ),
      )
      return
    }
    const openTimeout = setTimeout(() => {
      try {
        socket.close(1008, 'live log connection timed out')
      } catch {
        // The socket may have already failed before it opened.
      }
      settle(
        failure(
          'live_log_connect_timeout',
          'the live log WebSocket timed out',
          ExitCode.unavailable,
        ),
      )
    }, 15_000)
    socket.addEventListener('open', () => {
      opened = true
    })
    socket.addEventListener('message', (message) => {
      const raw = frameText(message.data)
      if (
        raw === undefined ||
        new TextEncoder().encode(raw).byteLength > liveLogMaximumFrameBytes
      ) {
        try {
          socket.close(1009, 'live log frame too large')
        } catch {
          // The socket may already be closed.
        }
        settle(
          failure(
            'live_log_frame_invalid',
            'the live log stream returned an oversized frame',
            ExitCode.unavailable,
          ),
        )
        return
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(raw) as unknown
      } catch {
        try {
          socket.close(1008, 'live log frame is invalid')
        } catch {
          // The socket may already be closed.
        }
        settle(
          failure(
            'live_log_frame_invalid',
            'the live log stream returned an invalid frame',
            ExitCode.unavailable,
          ),
        )
        return
      }
      const event = liveLogEntryMatches(decoded, input, organizationId, streamEpoch)
      if (event === undefined) return
      events.push(event)
      if (events.length >= liveLogMaximumEvents) {
        try {
          socket.close(1000, 'live log client bound reached')
        } catch {
          // The socket may already be closed.
        }
      }
    })
    socket.addEventListener('error', () => {
      settle(
        failure('live_log_stream_failed', 'the live log WebSocket failed', ExitCode.unavailable),
      )
    })
    socket.addEventListener('close', (event) => {
      if (settled) return
      if (event.code === 1000 || (events.length >= liveLogMaximumEvents && event.code === 1001)) {
        settle(events)
        return
      }
      settle(
        failure(
          opened ? 'live_log_stream_closed' : 'live_log_connect_rejected',
          opened
            ? 'the live log WebSocket closed unexpectedly'
            : 'the live log WebSocket was rejected',
          ExitCode.unavailable,
          { code: event.code },
        ),
      )
    })
  })
}
const apiLayer = (profile: CliProfile) => {
  const request = async (input: ApiRequest): Promise<ApiResponse> => {
    if (input.organizationScoped === true && input.organization === undefined)
      throw failure(
        'organization_required',
        'the API adapter requires an organization for this request',
        ExitCode.usage,
      )
    const path =
      input.organizationScoped === true
        ? input.path.replace(
            '/v1',
            `/v1/organizations/${encodeURIComponent(input.organization ?? '')}`,
          )
        : input.path
    const client = createGridoraClient({
      baseUrl: secureUrl(profile.apiOrigin).origin,
      headers: accessGatewayHeaders(await accessToken(profile)),
      fetch: (request, init) => fetch(request, { ...init, redirect: 'error' }),
    })
    const result = await Effect.runPromise(
      client.request(
        input.method,
        path,
        Schema.Unknown,
        input.body,
        input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey },
      ),
    ).catch((cause: unknown) => {
      if (!(cause instanceof GridoraClientError)) throw cause
      throw failure(
        cause.code,
        cause.detail,
        cause.status === 401
          ? ExitCode.authentication
          : cause.status === 403
            ? ExitCode.authorization
            : cause.status === 404
              ? ExitCode.notFound
              : cause.status === 409
                ? ExitCode.conflict
                : cause.status >= 500 || cause.status === 0
                  ? ExitCode.unavailable
                  : ExitCode.validation,
        { retryable: cause.retryable, status: cause.status },
      )
    })
    const data: unknown = result
    const directOperationId =
      typeof data === 'object' &&
      data !== null &&
      'operationId' in data &&
      typeof data.operationId === 'string'
        ? data.operationId
        : undefined
    const nestedOperationId =
      typeof data === 'object' &&
      data !== null &&
      'job' in data &&
      typeof data.job === 'object' &&
      data.job !== null &&
      'operationId' in data.job &&
      typeof data.job.operationId === 'string'
        ? data.job.operationId
        : undefined
    const operationId = directOperationId ?? nestedOperationId
    return { status: 200, data, ...(operationId === undefined ? {} : { operationId }) }
  }
  return Layer.succeed(GridoraApi, {
    request: (input) =>
      Effect.tryPromise({
        try: () => request(input),
        catch: (cause) =>
          cause instanceof CliError
            ? cause
            : failure('request_failed', 'API request failed', ExitCode.unavailable, String(cause)),
      }),
    watchOperation: (id, timeout, organization) =>
      Effect.tryPromise({
        try: async () => {
          const deadline = Date.now() + timeout
          while (Date.now() < deadline) {
            const result = await request({
              method: 'GET',
              path: `/v1/operations/${id}`,
              ...(organization === undefined ? {} : { organization }),
            })
            const completion = classifyOperationResult(id, result.data)
            if (completion.done) return completion.value
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
          throw failure('timeout', `operation ${id} timed out`, ExitCode.timeout)
        },
        catch: (cause) =>
          cause instanceof CliError
            ? cause
            : failure(
                'watch_failed',
                'operation watch failed',
                ExitCode.unavailable,
                String(cause),
              ),
      }),
    streamLogs: (input) =>
      Effect.tryPromise({
        try: () => collectLiveLogs(profile, request, input),
        catch: (cause) =>
          cause instanceof CliError
            ? cause
            : failure(
                'live_log_stream_failed',
                'the live log stream failed',
                ExitCode.unavailable,
                String(cause),
              ),
      }),
  })
}

export const classifyOperationResult = (
  id: string,
  value: unknown,
): { readonly done: false } | { readonly done: true; readonly value: unknown } => {
  const status =
    typeof value === 'object' && value !== null && 'status' in value ? String(value.status) : ''
  if (status === 'succeeded') return { done: true, value }
  if (['failed', 'failed_terminal', 'cancelled'].includes(status))
    throw failure(
      'operation_failed',
      `operation ${id} ended with status ${status}`,
      ExitCode.operationFailed,
      value,
    )
  return { done: false }
}
export const parseGlobals = (argv: ReadonlyArray<string>) => {
  let profile = 'default'
  let origin = 'https://api.gridora.dev'
  let authIssuer: string | undefined
  const command: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--profile' || token === '--api-origin' || token === '--auth-issuer') {
      const value = argv[index + 1]
      if (value === undefined) throw failure('usage', `${token} requires a value`, ExitCode.usage)
      if (token === '--profile') profile = value
      else if (token === '--api-origin') origin = value
      else authIssuer = value
      index += 1
    } else if (token !== undefined) command.push(token)
  }
  if (!profileNamePattern.test(profile))
    throw failure('invalid_profile', 'profile name is invalid', ExitCode.usage)
  return { profile, origin, authIssuer, command }
}
export const runNodeCli = async (argv: ReadonlyArray<string>): Promise<number> => {
  try {
    const global = parseGlobals(argv)
    if (global.command.includes('--help') || global.command.length === 0) {
      process.stdout.write(
        'gridora <auth|organizations|plugins|providers|nodes|servers|mods|backups|operations|logs> [command]\n',
      )
      return 0
    }
    const parsed: ParsedCommand = await Effect.runPromise(parseCommand(global.command))
    let result: unknown
    if (parsed.localAction === 'auth-login')
      result = await login(global.profile, global.origin, global.authIssuer, parsed.organization)
    else if (parsed.localAction === 'auth-logout') {
      const profile = await loadProfile(global.profile)
      const refreshToken = await keychain.get(global.profile)
      if (!parsed.localOnly && refreshToken !== undefined) {
        if (profile?.authIssuer === undefined || profile.clientId === undefined)
          throw failure(
            'revocation_unavailable',
            'profile lacks pinned OAuth revocation metadata; use --local-only to forget locally',
            ExitCode.authentication,
          )
        await revokeRefreshToken({
          apiOrigin: profile.apiOrigin,
          authIssuer: profile.authIssuer,
          clientId: profile.clientId,
          refreshToken,
        })
      }
      await keychain.remove(global.profile)
      memoryTokens.delete(global.profile)
      result = {
        loggedOutLocally: true,
        tokensRevoked: refreshToken !== undefined && !parsed.localOnly,
        localOnly: parsed.localOnly,
      }
    } else if (parsed.localAction === 'auth-status') {
      const profile = await loadProfile(global.profile)
      result = {
        authenticated: profile !== undefined && (await keychain.get(global.profile)) !== undefined,
        profile: profile ?? null,
      }
    } else if (parsed.localAction === 'organization-switch') {
      const profile = await loadProfile(global.profile)
      const organization = parsed.positional[2]
      if (profile === undefined || organization === undefined || parsed.request === undefined)
        throw failure('profile_not_found', 'login first', ExitCode.authentication)
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* GridoraApi
          return yield* api.request(parsed.request!)
        }).pipe(Effect.provide(apiLayer(profile))),
      )
      await saveProfile({ ...profile, activeOrganization: organization })
      result = { activeOrganization: organization, operation: response.data }
    } else {
      const profile = await loadProfile(global.profile)
      if (profile === undefined)
        throw failure('profile_not_found', 'run gridora auth login', ExitCode.authentication)
      const profileLayer = Layer.succeed(ProfileStore, {
        load: (name: string) =>
          Effect.tryPromise({
            try: () => loadProfile(name),
            catch: (cause) =>
              failure(
                'profile_read_failed',
                'profile read failed',
                ExitCode.internal,
                String(cause),
              ),
          }),
        save: (value: CliProfile) =>
          Effect.tryPromise({
            try: () => saveProfile(value),
            catch: (cause) =>
              failure(
                'profile_write_failed',
                'profile write failed',
                ExitCode.internal,
                String(cause),
              ),
          }),
        remove: (name: string) =>
          Effect.tryPromise({
            try: () => rm(pathFor(name), { force: true }),
            catch: (cause) =>
              failure(
                'profile_remove_failed',
                'profile remove failed',
                ExitCode.internal,
                String(cause),
              ),
          }),
      })
      const fileLayer = Layer.succeed(CliFiles, {
        readUtf8: (path: string) =>
          Effect.tryPromise({
            try: () => readFile(path, 'utf8'),
            catch: (cause) =>
              failure(
                'file_read_failed',
                `could not read ${path}`,
                ExitCode.validation,
                String(cause),
              ),
          }),
      })
      result = await Effect.runPromise(
        executeRemoteCommand(parsed, global.profile).pipe(
          Effect.provide(Layer.mergeAll(profileLayer, fileLayer, apiLayer(profile))),
        ),
      )
    }
    process.stdout.write(renderOutput(result, parsed.format))
    return 0
  } catch (cause) {
    const caught =
      cause instanceof CliError
        ? cause
        : failure(
            'internal',
            cause instanceof Error ? cause.message : String(cause),
            ExitCode.internal,
          )
    process.stderr.write(`${JSON.stringify(errorEnvelope(caught))}\n`)
    return caught.exitCode
  }
}

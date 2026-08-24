import { Schema } from 'effect'

export class SteamPlanError extends Schema.TaggedError<SteamPlanError>()('SteamPlanError', {
  code: Schema.Literals(['credentialed-disabled', 'invalid-app-id', 'unsafe-path']),
  message: Schema.String,
}) {}

export interface SteamInstallRequest {
  readonly serverId: string
  readonly appId: number
  readonly validate: boolean
  readonly credentialMode: 'anonymous' | 'credential-reference'
  readonly credentialReference?: string
}

export interface SteamAppPlanRequest {
  readonly installRoot: string
  readonly appId: number
  readonly validate: boolean
  readonly operation: 'install' | 'update'
  readonly branch?: string
  readonly credentialMode: 'anonymous' | 'credential-reference'
}

export interface ProcessPlan {
  readonly executable: '/usr/local/bin/steamcmd'
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly uid: 10001
  readonly gid: 10001
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutSeconds: 3600
  readonly redact: ReadonlyArray<string>
}

const safeInstallRoot = (root: string) =>
  root.startsWith('/var/lib/gridora/servers/') &&
  !root.includes('\0') &&
  root
    .split('/')
    .every(
      (segment, index) => index === 0 || (segment !== '' && segment !== '.' && segment !== '..'),
    )

/** Produces data-only argv. Runners must invoke this without a shell. */
export const createSteamAppPlan = (request: SteamAppPlanRequest): ProcessPlan => {
  if (!Number.isSafeInteger(request.appId) || request.appId <= 0)
    throw new SteamPlanError({
      code: 'invalid-app-id',
      message: 'Steam App ID must be a positive integer',
    })
  if (request.credentialMode !== 'anonymous')
    throw new SteamPlanError({
      code: 'credentialed-disabled',
      message: 'credentialed SteamCMD mode is not production-ready',
    })
  if (!safeInstallRoot(request.installRoot))
    throw new SteamPlanError({ code: 'unsafe-path', message: 'install root is not path-safe' })
  if (request.branch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.branch))
    throw new SteamPlanError({ code: 'unsafe-path', message: 'Steam branch is not safe' })
  const serverRoot = request.installRoot.endsWith('/game')
    ? request.installRoot.slice(0, -'/game'.length)
    : request.installRoot
  return {
    executable: '/usr/local/bin/steamcmd',
    argv: [
      '+force_install_dir',
      request.installRoot,
      '+login',
      'anonymous',
      '+app_update',
      String(request.appId),
      ...(request.branch === undefined ? [] : ['-beta', request.branch]),
      ...(request.validate ? ['validate'] : []),
      '+quit',
    ],
    cwd: request.installRoot,
    uid: 10001,
    gid: 10001,
    environment: { HOME: `${serverRoot}/state/steam` },
    timeoutSeconds: 3600,
    redact: [],
  }
}

export const createSteamInstallPlan = (request: SteamInstallRequest): ProcessPlan => {
  if (!Number.isSafeInteger(request.appId) || request.appId <= 0) {
    throw new SteamPlanError({
      code: 'invalid-app-id',
      message: 'Steam App ID must be a positive integer',
    })
  }
  if (request.credentialMode !== 'anonymous') {
    throw new SteamPlanError({
      code: 'credentialed-disabled',
      message: 'credentialed SteamCMD mode is not production-ready',
    })
  }
  if (
    request.serverId === '.' ||
    request.serverId === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(request.serverId)
  ) {
    throw new SteamPlanError({ code: 'unsafe-path', message: 'server ID is not path-safe' })
  }
  return createSteamAppPlan({
    installRoot: `/var/lib/gridora/servers/${request.serverId}/game`,
    appId: request.appId,
    validate: request.validate,
    operation: 'install',
    credentialMode: request.credentialMode,
  })
}

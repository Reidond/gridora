import { request as httpRequest } from 'node:http'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'

/**
 * The agent may use the host Docker socket to create a short-lived helper, but
 * this is the only shape accepted for plugin/installer work.  In particular,
 * callers cannot provide a host path, a bind list, a network, or a Docker API
 * path of their own.
 */
export const IsolatedJobSpec = Schema.Struct({
  jobId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  serverId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  image: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  executable: Schema.String.check(
    Schema.isPattern(/^(?:steamcmd|ArmaReforgerServer|valheim_server\.x86_64|gridora-game-query)$/),
  ),
  arguments: Schema.Array(Schema.String).check(Schema.isMaxLength(128)),
  workingDirectory: Schema.String.check(
    Schema.isPattern(
      /^\/work(?:\/(?:game|config|data|mods|staging|backups|state)(?:\/[A-Za-z0-9._-]+)*)?$/,
    ),
  ),
  environment: Schema.Record(Schema.String, Schema.String),
  timeoutSeconds: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 3600 }),
  ),
  restoreValidationBackupId: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  ),
  writableStagingRelative: Schema.optional(
    Schema.String.check(Schema.isPattern(/^mods-[1-9][0-9]*$/)),
  ),
})
export type IsolatedJobSpec = typeof IsolatedJobSpec.Type

export const IsolatedJobResult = Schema.Struct({
  output: Schema.String,
  exitCode: Schema.Number.check(Schema.isInt()),
})
export type IsolatedJobResult = typeof IsolatedJobResult.Type

export class IsolatedJobError extends Schema.TaggedError<IsolatedJobError>()('IsolatedJobError', {
  code: Schema.Literals(['invalid', 'unavailable', 'conflict', 'failed', 'timeout']),
  message: Schema.String,
}) {}

export class IsolatedJobEngine extends Context.Service<
  IsolatedJobEngine,
  {
    readonly run: (spec: IsolatedJobSpec) => Effect.Effect<IsolatedJobResult, IsolatedJobError>
  }
>()('gridora/docker-runtime/IsolatedJobEngine') {}

const SERVER_ROOT = '/var/lib/gridora/servers'
const JOB_PREFIX = 'gridora-job-'
const MAX_ARGUMENT_LENGTH = 4096
const MAX_ENVIRONMENT_ENTRIES = 16
const MAX_OUTPUT_BYTES = 256 * 1024
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'STEAM_RUNTIME',
  'STEAMCMD_HOME',
])
const SECRET_MARKER = /(password|secret|token|credential|authorization|bearer|private[_-]?key|pem)/i
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/

const safeSegment = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..'

const safeWorkPath = (value: string): boolean =>
  /^\/work(?:\/(?:game|config|data|mods|staging|backups|state)(?:\/[A-Za-z0-9._-]+)*)?$/.test(
    value,
  ) && !value.includes('..')

const redactOutput = (value: string): string =>
  value
    .replace(/password\s*[=:]\s*\S+/gi, 'password=[redacted]')
    .replace(/(secret|token|credential|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(0, MAX_OUTPUT_BYTES)

const validateSpec = (spec: IsolatedJobSpec): void => {
  if (!safeSegment(spec.jobId) || !safeSegment(spec.serverId))
    throw new IsolatedJobError({ code: 'invalid', message: 'isolated job identity is unsafe' })
  if (!/^sha256:[a-f0-9]{64}$/.test(spec.image))
    throw new IsolatedJobError({
      code: 'invalid',
      message: 'isolated job image is not digest pinned',
    })
  if (!safeWorkPath(spec.workingDirectory))
    throw new IsolatedJobError({
      code: 'invalid',
      message: 'isolated working directory is outside /work',
    })
  if (
    spec.arguments.length > 128 ||
    spec.arguments.some(
      (argument) => argument.length > MAX_ARGUMENT_LENGTH || argument.includes('\0'),
    )
  )
    throw new IsolatedJobError({ code: 'invalid', message: 'isolated job arguments are unsafe' })
  const entries = Object.entries(spec.environment)
  if (entries.length > MAX_ENVIRONMENT_ENTRIES)
    throw new IsolatedJobError({ code: 'invalid', message: 'isolated environment is too large' })
  for (const [key, value] of entries) {
    if (
      !ALLOWED_ENVIRONMENT_KEYS.has(key) ||
      SECRET_MARKER.test(key) ||
      SECRET_MARKER.test(value) ||
      value.includes('\0')
    )
      throw new IsolatedJobError({
        code: 'invalid',
        message: 'isolated environment contains a secret or unsupported key',
      })
  }
  if (
    spec.restoreValidationBackupId !== undefined &&
    (spec.writableStagingRelative !== undefined ||
      !safeSegment(spec.restoreValidationBackupId) ||
      spec.workingDirectory !== `/work/staging/restore-${spec.jobId}`)
  )
    throw new IsolatedJobError({
      code: 'invalid',
      message: 'isolated restore validation staging identity is unsafe',
    })
}

const fixedMounts = (spec: IsolatedJobSpec): readonly string[] => {
  const root = `${SERVER_ROOT}/${spec.serverId}`
  return [
    `${root}/game:/work/game:rw`,
    `${root}/config:/work/config:ro`,
    `${root}/data:/work/data:rw`,
    `${root}/mods:/work/mods:rw`,
    // Configuration staging is an agent-owned cutover area. Installer and mod
    // jobs do not need to write it; keeping it read-only prevents a compromised
    // plugin from racing the agent's descriptor-based renderer.
    `${root}/staging:/work/staging:ro`,
    ...(spec.writableStagingRelative === undefined
      ? []
      : [
          `${root}/staging/${spec.writableStagingRelative}:/work/staging/${spec.writableStagingRelative}:rw`,
        ]),
    `${root}/backups:/work/backups:rw`,
    `${root}/state:/work/state:rw`,
    ...(spec.restoreValidationBackupId === undefined
      ? []
      : [
          `${SERVER_ROOT}/.gridora-restore-${spec.serverId}-${spec.restoreValidationBackupId}:/work/staging/restore-${spec.jobId}:ro`,
        ]),
  ]
}

export const validateRestoreValidationSource = async (
  spec: IsolatedJobSpec,
  serversRoot = SERVER_ROOT,
): Promise<void> => {
  if (spec.restoreValidationBackupId === undefined) return
  validateSpec(spec)
  const expected = join(
    serversRoot,
    `.gridora-restore-${spec.serverId}-${spec.restoreValidationBackupId}`,
  )
  const metadata = await lstat(expected)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 10001 ||
    metadata.gid !== 10001 ||
    (metadata.mode & 0o022) !== 0 ||
    (await realpath(expected)) !== expected
  )
    throw new IsolatedJobError({
      code: 'invalid',
      message: 'isolated restore validation source ownership/path is unsafe',
    })
}

/** Re-check the quota helper's fixed ownership/no-symlink contract immediately before bind. */
export const validateIsolatedBindSources = async (
  serverId: string,
  writableStagingRelative?: string,
  serversRoot = SERVER_ROOT,
): Promise<void> => {
  if (!safeSegment(serverId))
    throw new IsolatedJobError({ code: 'invalid', message: 'isolated server identity is unsafe' })
  const root = join(serversRoot, serverId)
  const rootMeta = await lstat(root)
  if (
    !rootMeta.isDirectory() ||
    rootMeta.isSymbolicLink() ||
    rootMeta.uid !== 0 ||
    (rootMeta.mode & 0o022) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new IsolatedJobError({
      code: 'invalid',
      message: 'isolated server root ownership/path is unsafe',
    })
  for (const child of ['game', 'config', 'data', 'mods', 'staging', 'backups', 'state']) {
    const path = join(root, child)
    const metadata = await lstat(path)
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== 10001 ||
      metadata.gid !== 10001 ||
      (metadata.mode & 0o002) !== 0 ||
      (await realpath(path)) !== path
    )
      throw new IsolatedJobError({
        code: 'invalid',
        message: 'isolated bind source ownership/path is unsafe',
      })
  }
  if (writableStagingRelative !== undefined) {
    if (!/^mods-[1-9][0-9]*$/.test(writableStagingRelative))
      throw new IsolatedJobError({
        code: 'invalid',
        message: 'writable staging identity is unsafe',
      })
    const path = join(root, 'staging', writableStagingRelative)
    const metadata = await lstat(path)
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.gid !== 10001 ||
      (metadata.mode & 0o007) !== 0 ||
      (await realpath(path)) !== path
    )
      throw new IsolatedJobError({
        code: 'invalid',
        message: 'writable staging source ownership/path is unsafe',
      })
  }
}

/** Exported for behavioral tests and for the root helper's admission review. */
export const isolatedJobCreateBody = (spec: IsolatedJobSpec): Readonly<Record<string, unknown>> => {
  validateSpec(spec)
  return {
    Image: spec.image,
    Entrypoint: [],
    Cmd: [spec.executable, ...spec.arguments],
    WorkingDir: spec.workingDirectory,
    User: '10001:10001',
    Env: Object.entries(spec.environment).map(([key, value]) => `${key}=${value}`),
    Labels: {
      'dev.gridora.job': `${JOB_PREFIX}${spec.jobId}`,
      'dev.gridora.server': spec.serverId,
      'dev.gridora.image': spec.image,
      ...(spec.restoreValidationBackupId === undefined
        ? {}
        : { 'dev.gridora.restore-backup': spec.restoreValidationBackupId }),
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      // This network is provisioned by the node image with destination
      // allow-list firewall rules for the reviewed plugin (Steam/mod hosts).
      // The engine verifies the policy label before creating a job. It is fixed
      // here; callers cannot select host, bridge, or arbitrary namespaces.
      NetworkMode: 'gridora-plugin-egress',
      Binds: fixedMounts(spec),
      PidsLimit: 256,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  }
}

export const decodeDockerLogOutput = (body: Buffer): string => {
  const output: Buffer[] = []
  let offset = 0
  while (offset + 8 <= body.length) {
    const stream = body[offset]
    if (
      (stream !== 1 && stream !== 2) ||
      body[offset + 1] !== 0 ||
      body[offset + 2] !== 0 ||
      body[offset + 3] !== 0
    )
      return body.toString('utf8')
    const length = body.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = start + length
    if (end > body.length) return body.toString('utf8')
    output.push(body.subarray(start, end))
    offset = end
  }
  return offset === body.length && output.length > 0
    ? Buffer.concat(output).toString('utf8')
    : body.toString('utf8')
}

const dockerRequest = (
  socketPath: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: unknown,
  accepted: readonly number[],
  timeoutMs: number,
): Effect.Effect<{ readonly status: number; readonly body: string }, IsolatedJobError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body)
        const request = httpRequest(
          {
            socketPath,
            method,
            path,
            headers:
              encoded === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(encoded),
                  },
          },
          (response) => {
            const chunks: Buffer[] = []
            let total = 0
            response.on('data', (chunk: Buffer) => {
              if (total >= MAX_OUTPUT_BYTES) return
              const bounded = chunk.subarray(0, MAX_OUTPUT_BYTES - total)
              chunks.push(bounded)
              total += bounded.length
            })
            response.once('end', () => {
              const status = response.statusCode ?? 0
              if (!accepted.includes(status)) {
                reject(
                  new IsolatedJobError({
                    code: status === 409 ? 'conflict' : status === 408 ? 'timeout' : 'failed',
                    message: `Docker rejected isolated job operation ${method} ${path} (${status})`,
                  }),
                )
                return
              }
              const responseBody = Buffer.concat(chunks).subarray(0, MAX_OUTPUT_BYTES)
              resolve({
                status,
                body: path.includes('/logs?')
                  ? decodeDockerLogOutput(responseBody)
                  : responseBody.toString('utf8'),
              })
            })
          },
        )
        request.once('error', reject)
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error('isolated job Docker request timed out'))
        })
        signal.addEventListener(
          'abort',
          () => request.destroy(new Error('isolated job Docker request cancelled')),
          { once: true },
        )
        if (encoded !== undefined) request.write(encoded)
        request.end()
      }),
    catch: (cause) =>
      cause instanceof IsolatedJobError
        ? cause
        : new IsolatedJobError({
            code: 'unavailable',
            message: `isolated Docker job unavailable: ${String(cause)}`,
          }),
  })

/**
 * Adoption is only permitted for the exact canonical container shape. The
 * Docker name is not an identity: a foreign same-name container must never be
 * started, reused, or removed by the cleanup path.
 */
const mergeEnvironment = (
  imageEnvironment: readonly string[],
  planEnvironment: Readonly<Record<string, string>>,
): readonly string[] => {
  const merged = new Map<string, string>()
  for (const entry of imageEnvironment) {
    const separator = entry.indexOf('=')
    if (separator <= 0) throw new Error('image environment entry is malformed')
    merged.set(entry.slice(0, separator), entry.slice(separator + 1))
  }
  for (const [key, value] of Object.entries(planEnvironment)) merged.set(key, value)
  return [...merged].map(([key, value]) => `${key}=${value}`)
}

export const validateIsolatedImageEnvironment = (
  body: string,
  expectedImage: string,
): readonly string[] => {
  try {
    const inspected = JSON.parse(body) as Record<string, unknown>
    const config = inspected.Config as Record<string, unknown> | undefined
    const environment = config?.Env
    if (
      inspected.Id !== expectedImage ||
      (environment !== undefined && environment !== null && !Array.isArray(environment))
    )
      throw new Error('image identity or environment shape does not match')
    const entries = (environment ?? []) as unknown[]
    if (
      entries.length > 64 ||
      entries.some((entry) => {
        if (typeof entry !== 'string' || entry.length > MAX_ARGUMENT_LENGTH || entry.includes('\0'))
          return true
        const separator = entry.indexOf('=')
        return (
          separator <= 0 ||
          !ENVIRONMENT_KEY.test(entry.slice(0, separator)) ||
          SECRET_MARKER.test(entry)
        )
      })
    )
      throw new Error('image environment is unsafe')
    const typed = entries as string[]
    if (new Set(typed.map((entry) => entry.slice(0, entry.indexOf('=')))).size !== typed.length)
      throw new Error('image environment keys are duplicated')
    return typed
  } catch (cause) {
    throw new IsolatedJobError({
      code: 'invalid',
      message: `isolated job image metadata is unsafe: ${String(cause)}`,
    })
  }
}

export const isAdoptableIsolatedJob = (
  body: string,
  spec: IsolatedJobSpec,
  imageEnvironment: readonly string[] = [],
): boolean => {
  try {
    const inspected = JSON.parse(body) as Record<string, unknown>
    const config = inspected.Config as Record<string, unknown> | undefined
    const hostConfig = inspected.HostConfig as Record<string, unknown> | undefined
    const expected = isolatedJobCreateBody(spec)
    const expectedConfig = expected
    const expectedHost = expected.HostConfig as Record<string, unknown>
    const expectedLabels = expected.Labels as Record<string, string>
    const expectedEnv = mergeEnvironment(imageEnvironment, spec.environment)
    const empty = (value: unknown): boolean =>
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    const disabled = (value: unknown): boolean =>
      value === undefined || value === null || value === false
    const restartDisabled = (value: unknown): boolean => {
      if (value === undefined || value === null) return true
      if (typeof value !== 'object' || Array.isArray(value)) return false
      const policy = value as Record<string, unknown>
      return (
        (policy.Name === '' || policy.Name === 'no') &&
        (policy.MaximumRetryCount === undefined || policy.MaximumRetryCount === 0) &&
        Object.keys(policy).every((key) => key === 'Name' || key === 'MaximumRetryCount')
      )
    }
    const actualEnv = Array.isArray(config?.Env)
      ? config.Env.filter((value): value is string => typeof value === 'string')
      : []
    const exactStrings = (actual: unknown, expectedValue: unknown): boolean =>
      Array.isArray(actual) &&
      Array.isArray(expectedValue) &&
      actual.every((value): value is string => typeof value === 'string') &&
      expectedValue.every((value): value is string => typeof value === 'string') &&
      JSON.stringify([...actual].sort()) === JSON.stringify([...expectedValue].sort())
    const exactRecord = (actual: unknown, expectedValue: unknown): boolean => {
      if (
        typeof actual !== 'object' ||
        actual === null ||
        Array.isArray(actual) ||
        typeof expectedValue !== 'object' ||
        expectedValue === null ||
        Array.isArray(expectedValue)
      )
        return false
      const actualEntries = Object.entries(actual).sort(([left], [right]) =>
        left.localeCompare(right),
      )
      const expectedEntries = Object.entries(expectedValue).sort(([left], [right]) =>
        left.localeCompare(right),
      )
      return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries)
    }
    const exactLogConfig = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const actual = value as Record<string, unknown>
      const expectedLog = expectedHost.LogConfig as Record<string, unknown>
      return actual.Type === expectedLog.Type && exactRecord(actual.Config, expectedLog.Config)
    }
    return (
      config?.Image === expectedConfig.Image &&
      JSON.stringify(config?.Entrypoint) === JSON.stringify([]) &&
      config?.User === expectedConfig.User &&
      config?.WorkingDir === expectedConfig.WorkingDir &&
      JSON.stringify(config?.Cmd) === JSON.stringify(expectedConfig.Cmd) &&
      exactRecord(config?.Labels, expectedLabels) &&
      JSON.stringify([...actualEnv].sort()) === JSON.stringify([...expectedEnv].sort()) &&
      actualEnv.every((value) => !SECRET_MARKER.test(value)) &&
      exactStrings(hostConfig?.Binds, expectedHost.Binds) &&
      hostConfig?.NetworkMode === 'gridora-plugin-egress' &&
      hostConfig?.Privileged === false &&
      hostConfig?.ReadonlyRootfs === true &&
      JSON.stringify(hostConfig?.CapDrop) === JSON.stringify(['ALL']) &&
      empty(hostConfig?.CapAdd) &&
      empty(hostConfig?.Devices) &&
      empty(hostConfig?.DeviceRequests) &&
      empty(hostConfig?.DeviceCgroupRules) &&
      // Docker has both legacy Binds and a structured Mounts API. Checking
      // only Binds would permit a same-name container to add the host Docker
      // socket or another server directory through HostConfig.Mounts.
      empty(hostConfig?.Mounts) &&
      empty(hostConfig?.Tmpfs) &&
      empty(hostConfig?.VolumesFrom) &&
      empty(hostConfig?.Links) &&
      empty(hostConfig?.ExtraHosts) &&
      empty(hostConfig?.PortBindings) &&
      disabled(hostConfig?.PublishAllPorts) &&
      disabled(hostConfig?.AutoRemove) &&
      disabled(hostConfig?.OomKillDisable) &&
      disabled(hostConfig?.Init) &&
      restartDisabled(hostConfig?.RestartPolicy) &&
      empty(hostConfig?.Dns) &&
      empty(hostConfig?.DnsOptions) &&
      empty(hostConfig?.DnsSearch) &&
      empty(hostConfig?.GroupAdd) &&
      empty(hostConfig?.Ulimits) &&
      empty(hostConfig?.Sysctls) &&
      empty(hostConfig?.StorageOpt) &&
      empty(hostConfig?.CgroupParent) &&
      empty(hostConfig?.PidMode) &&
      (empty(hostConfig?.IpcMode) || hostConfig?.IpcMode === 'private') &&
      empty(hostConfig?.UTSMode) &&
      empty(hostConfig?.UsernsMode) &&
      hostConfig?.Memory === expectedHost.Memory &&
      hostConfig?.NanoCpus === expectedHost.NanoCpus &&
      hostConfig?.PidsLimit === expectedHost.PidsLimit &&
      JSON.stringify(hostConfig?.SecurityOpt) === JSON.stringify(expectedHost.SecurityOpt) &&
      exactLogConfig(hostConfig?.LogConfig)
    )
  } catch {
    return false
  }
}

const cleanupJob = (
  socketPath: string,
  name: string,
  spec: IsolatedJobSpec,
  imageEnvironment: readonly string[],
): Effect.Effect<void, never> =>
  dockerRequest(
    socketPath,
    'GET',
    `/v1.43/containers/${encodeURIComponent(name)}/json`,
    undefined,
    [200, 404],
    15_000,
  ).pipe(
    Effect.flatMap((inspected) =>
      inspected.status === 404 || !isAdoptableIsolatedJob(inspected.body, spec, imageEnvironment)
        ? Effect.void
        : dockerRequest(
            socketPath,
            'DELETE',
            `/v1.43/containers/${encodeURIComponent(name)}?force=1`,
            undefined,
            [204, 404],
            15_000,
          ).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          ),
    ),
    Effect.catch(() => Effect.void),
  )

const parseWaitCode = (body: string): number => {
  try {
    const parsed = JSON.parse(body) as { StatusCode?: unknown }
    return typeof parsed.StatusCode === 'number' ? parsed.StatusCode : -1
  } catch {
    return -1
  }
}

/** Validate the root-provisioned default-deny egress network before creation. */
export const assertPluginNetwork = (body: string): void => {
  try {
    const network = JSON.parse(body) as Record<string, unknown>
    const labels = network.Labels as Record<string, unknown> | undefined
    const options = network.Options as Record<string, unknown> | undefined
    if (
      network.Name !== 'gridora-plugin-egress' ||
      labels?.['dev.gridora.network'] !== 'plugin-egress' ||
      labels?.['dev.gridora.network-policy'] !== 'gridora-plugin-egress-v1' ||
      options?.['com.docker.network.bridge.name'] !== 'gridora-egress0' ||
      network.Internal !== false ||
      network.Attachable !== false
    )
      throw new Error('plugin egress network is foreign or not bounded')
  } catch (cause) {
    throw new IsolatedJobError({
      code: 'conflict',
      message: `plugin egress network validation failed: ${String(cause)}`,
    })
  }
}

const runJob = (
  socketPath: string,
  spec: IsolatedJobSpec,
): Effect.Effect<IsolatedJobResult, IsolatedJobError> =>
  Effect.gen(function* () {
    validateSpec(spec)
    yield* Effect.tryPromise({
      try: async () => {
        await validateIsolatedBindSources(spec.serverId, spec.writableStagingRelative)
        await validateRestoreValidationSource(spec)
      },
      catch: (error) =>
        error instanceof IsolatedJobError
          ? error
          : new IsolatedJobError({
              code: 'invalid',
              message: `isolated bind source validation failed: ${String(error)}`,
            }),
    })
    const network = yield* dockerRequest(
      socketPath,
      'GET',
      '/v1.43/networks/gridora-plugin-egress',
      undefined,
      [200],
      15_000,
    )
    yield* Effect.try({
      try: () => assertPluginNetwork(network.body),
      catch: (error) =>
        error instanceof IsolatedJobError
          ? error
          : new IsolatedJobError({ code: 'conflict', message: String(error) }),
    })
    const image = yield* dockerRequest(
      socketPath,
      'GET',
      `/v1.43/images/${encodeURIComponent(spec.image)}/json`,
      undefined,
      [200],
      15_000,
    )
    const imageEnvironment = yield* Effect.try({
      try: () => validateIsolatedImageEnvironment(image.body, spec.image),
      catch: (error) =>
        error instanceof IsolatedJobError
          ? error
          : new IsolatedJobError({ code: 'invalid', message: String(error) }),
    })
    const name = `${JOB_PREFIX}${spec.jobId}`
    const body = isolatedJobCreateBody(spec)
    return yield* Effect.gen(function* () {
      const create = yield* dockerRequest(
        socketPath,
        'POST',
        `/v1.43/containers/create?name=${encodeURIComponent(name)}`,
        body,
        [201, 409],
        15_000,
      )
      if (create.status === 409) {
        const inspected = yield* dockerRequest(
          socketPath,
          'GET',
          `/v1.43/containers/${encodeURIComponent(name)}/json`,
          undefined,
          [200],
          15_000,
        )
        if (!isAdoptableIsolatedJob(inspected.body, spec, imageEnvironment))
          return yield* Effect.fail(
            new IsolatedJobError({ code: 'conflict', message: 'existing isolated job is foreign' }),
          )
      }
      yield* dockerRequest(
        socketPath,
        'POST',
        `/v1.43/containers/${encodeURIComponent(name)}/start`,
        undefined,
        [204, 304],
        15_000,
      )
      const waited = yield* dockerRequest(
        socketPath,
        'POST',
        `/v1.43/containers/${encodeURIComponent(name)}/wait?condition=not-running`,
        undefined,
        [200],
        Math.max(15_000, spec.timeoutSeconds * 1000 + 15_000),
      )
      const exitCode = parseWaitCode(waited.body)
      const logs = yield* dockerRequest(
        socketPath,
        'GET',
        `/v1.43/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=512`,
        undefined,
        [200],
        15_000,
      )
      const output = redactOutput(logs.body)
      if (exitCode !== 0)
        return yield* Effect.fail(
          new IsolatedJobError({
            code: 'failed',
            message: `isolated job exited with ${String(exitCode)}: ${output}`,
          }),
        )
      return { output, exitCode }
    }).pipe(Effect.ensuring(cleanupJob(socketPath, name, spec, imageEnvironment)))
  }).pipe(
    Effect.catch((error) =>
      error instanceof IsolatedJobError
        ? Effect.fail(error)
        : Effect.fail(new IsolatedJobError({ code: 'failed', message: String(error) })),
    ),
  )

/** Fixed Docker API adapter; no caller-controlled command, path, mount, or network is exposed. */
export const NodeIsolatedJobEngine = (socketPath: '/var/run/docker.sock' | '/run/docker.sock') =>
  Layer.succeed(IsolatedJobEngine, { run: (spec) => runJob(socketPath, spec) })

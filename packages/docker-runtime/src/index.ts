import type { DeploymentSpec } from '@gridora/agent-protocol'
import { lstat, realpath, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { dirname } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import {
  makeProjectQuotaClient,
  PROJECT_QUOTA_API_VERSION,
  type ProjectQuotaClient,
  type ProjectQuotaProof,
} from './quota.js'

export * from './quota.js'
export * from './isolated.js'

export const DOCKER_API_VERSION = 'v1.43' as const

export class DockerPlanError extends Schema.TaggedError<DockerPlanError>()('DockerPlanError', {
  code: Schema.Literals(['unsafe-image', 'unsafe-mount', 'duplicate-port', 'invalid-label']),
  message: Schema.String,
}) {}

export interface DockerContainerPlan {
  readonly name: string
  readonly image: string
  readonly user: string
  readonly privileged: false
  readonly readOnlyRootFilesystem: true
  readonly capabilities: { readonly drop: readonly ['ALL'] }
  readonly securityOptions: readonly ['no-new-privileges:true']
  readonly network: string
  readonly mounts: ReadonlyArray<{
    readonly source: string
    readonly target: string
    readonly readOnly: boolean
  }>
  readonly ports: ReadonlyArray<{
    readonly published: number
    readonly target: number
    readonly protocol: 'tcp' | 'udp'
  }>
  readonly labels: Readonly<Record<string, string>>
  readonly limits: {
    readonly cpus: number
    readonly memoryBytes: number
    readonly pids: number
  }
  readonly diskPolicy: {
    readonly method: 'ext4-project-quota'
    readonly requestedBytes: number
  }
  readonly log: { readonly driver: 'local'; readonly maxSize: '10m'; readonly maxFiles: 5 }
  readonly stopGracePeriodSeconds: 60
}

export class DockerRuntimeError extends Schema.TaggedError<DockerRuntimeError>()(
  'DockerRuntimeError',
  {
    code: Schema.Literals(['unavailable', 'conflict', 'rejected']),
    message: Schema.String,
  },
) {}

export class DockerEngine extends Context.Service<
  DockerEngine,
  {
    readonly apply: (plan: DockerContainerPlan) => Effect.Effect<void, DockerRuntimeError>
    readonly start: (target: DockerTarget) => Effect.Effect<void, DockerRuntimeError>
    readonly stop: (target: DockerTarget) => Effect.Effect<void, DockerRuntimeError>
    readonly remove: (target: DockerTarget) => Effect.Effect<void, DockerRuntimeError>
  }
>()('gridora/docker-runtime/DockerEngine') {}

export interface DockerTarget {
  readonly organizationId: string
  readonly serverId: string
  readonly deploymentId: string
}

const safeSegment = (value: string): boolean =>
  value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value)

const isCanonicalAbsolutePath = (value: string): boolean => {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('//')) return false
  return value
    .slice(1)
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

export const createContainerPlan = (spec: DeploymentSpec): DockerContainerPlan => {
  if (!spec.image.runtime.startsWith('sha256:'))
    throw new DockerPlanError({
      code: 'unsafe-image',
      message: 'runtime image must be digest-pinned',
    })
  if (
    ![spec.organizationId, spec.serverId, spec.deploymentId, spec.operationId].every(safeSegment)
  ) {
    throw new DockerPlanError({
      code: 'invalid-label',
      message: 'identifiers contain unsafe label characters',
    })
  }
  const allowedRoot = `/var/lib/gridora/servers/${spec.serverId}/`
  if (
    spec.mounts.some(
      (mount) =>
        !isCanonicalAbsolutePath(mount.source) ||
        !isCanonicalAbsolutePath(mount.target) ||
        !mount.source.startsWith(allowedRoot) ||
        mount.source === '/var/run/docker.sock' ||
        mount.target === '/var/run/docker.sock',
    )
  ) {
    throw new DockerPlanError({
      code: 'unsafe-mount',
      message: 'mount is non-canonical, outside the server root, or exposes the Docker socket',
    })
  }
  const leases = new Set<string>()
  for (const port of spec.ports) {
    const lease = `${port.host}/${port.protocol}`
    if (leases.has(lease))
      throw new DockerPlanError({
        code: 'duplicate-port',
        message: `duplicate port lease ${lease}`,
      })
    leases.add(lease)
  }
  return {
    name: `gridora-${spec.serverId}`,
    image: spec.image.runtime,
    user: '10001:10001',
    privileged: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
    securityOptions: ['no-new-privileges:true'],
    network: `gridora-${spec.serverId}`,
    mounts: spec.mounts,
    ports: spec.ports.map((port) => ({
      published: port.host,
      target: port.container,
      protocol: port.protocol,
    })),
    labels: {
      'dev.gridora.organization': spec.organizationId,
      'dev.gridora.server': spec.serverId,
      'dev.gridora.deployment': spec.deploymentId,
      'dev.gridora.plugin': spec.plugin.id,
      'dev.gridora.operation': spec.operationId,
    },
    limits: {
      cpus: spec.resources.cpu,
      memoryBytes: spec.resources.memoryMiB * 1024 * 1024,
      pids: spec.resources.pids,
    },
    diskPolicy: {
      method: 'ext4-project-quota',
      requestedBytes: spec.resources.diskGiB * 1024 * 1024 * 1024,
    },
    log: { driver: 'local', maxSize: '10m', maxFiles: 5 },
    stopGracePeriodSeconds: 60,
  }
}

const checkedServerName = (serverId: string): string => {
  if (serverId === '.' || serverId === '..' || !safeSegment(serverId))
    throw new DockerRuntimeError({ code: 'rejected', message: 'server ID is not Docker-safe' })
  return `gridora-${serverId}`
}

export const dockerCreateBody = (plan: DockerContainerPlan): Readonly<Record<string, unknown>> => ({
  Image: plan.image,
  User: plan.user,
  Labels: plan.labels,
  HostConfig: {
    Privileged: false,
    ReadonlyRootfs: plan.readOnlyRootFilesystem,
    CapDrop: plan.capabilities.drop,
    SecurityOpt: plan.securityOptions,
    NetworkMode: plan.network,
    Binds: plan.mounts.map(
      (mount) => `${mount.source}:${mount.target}:${mount.readOnly ? 'ro' : 'rw'}`,
    ),
    PortBindings: Object.fromEntries(
      plan.ports.map((port) => [
        `${port.target}/${port.protocol}`,
        [{ HostIp: '0.0.0.0', HostPort: String(port.published) }],
      ]),
    ),
    Memory: plan.limits.memoryBytes,
    NanoCpus: Math.floor(plan.limits.cpus * 1_000_000_000),
    PidsLimit: plan.limits.pids,
    LogConfig: {
      Type: plan.log.driver,
      Config: { 'max-size': plan.log.maxSize, 'max-file': String(plan.log.maxFiles) },
    },
  },
})

export const dockerNetworkCreateBody = (
  plan: DockerContainerPlan,
): Readonly<Record<string, unknown>> => ({
  Name: plan.network,
  CheckDuplicate: true,
  Internal: true,
  Attachable: false,
  Labels: plan.labels,
})

const dockerCall = (
  socketPath: string,
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  accepted: ReadonlyArray<number> = [204],
): Effect.Effect<number, DockerRuntimeError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath,
            method,
            path,
            headers:
              body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(JSON.stringify(body)),
                  },
          },
          (response) => {
            response.resume()
            response.once('end', () => {
              const status = response.statusCode ?? 0
              if (accepted.includes(status)) resolve(status)
              else
                reject(
                  new DockerRuntimeError({
                    code: status === 409 ? 'conflict' : 'rejected',
                    message: `Docker rejected fixed operation ${method} ${path} (${status})`,
                  }),
                )
            })
          },
        )
        request.once('error', reject)
        request.setTimeout(15_000, () => request.destroy(new Error('Docker request timed out')))
        signal.addEventListener(
          'abort',
          () => request.destroy(new Error('Docker request cancelled')),
          {
            once: true,
          },
        )
        if (body !== undefined) request.write(JSON.stringify(body))
        request.end()
      }),
    catch: (cause) =>
      cause instanceof DockerRuntimeError
        ? cause
        : new DockerRuntimeError({
            code: 'unavailable',
            message: `Docker unavailable: ${String(cause)}`,
          }),
  })

const dockerInspect = (
  socketPath: string,
  path: string,
): Effect.Effect<Readonly<Record<string, unknown>>, DockerRuntimeError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
        const request = httpRequest({ socketPath, method: 'GET', path }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.once('end', () => {
            if (response.statusCode !== 200) {
              reject(new Error(`Docker inspect returned ${response.statusCode ?? 0}`))
              return
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
            } catch (cause) {
              reject(cause)
            }
          })
        })
        request.once('error', reject)
        request.setTimeout(15_000, () => request.destroy(new Error('Docker inspect timed out')))
        signal.addEventListener(
          'abort',
          () => request.destroy(new Error('Docker inspect cancelled')),
          {
            once: true,
          },
        )
        request.end()
      }),
    catch: (cause) =>
      new DockerRuntimeError({
        code: 'unavailable',
        message: `Docker inspect failed: ${String(cause)}`,
      }),
  })

const labelsMatch = (value: unknown, expected: Readonly<Record<string, string>>): boolean =>
  typeof value === 'object' &&
  value !== null &&
  Object.entries(expected).every(
    ([key, label]) => key in value && value[key as keyof typeof value] === label,
  )

export const canAdoptNetwork = (
  inspected: Readonly<Record<string, unknown>>,
  plan: DockerContainerPlan,
): boolean =>
  inspected.Internal === true &&
  inspected.Attachable === false &&
  labelsMatch(inspected.Labels, plan.labels)

export const canAdoptContainer = (
  inspected: Readonly<Record<string, unknown>>,
  plan: DockerContainerPlan,
): boolean => {
  const config = inspected.Config
  const hostConfig = inspected.HostConfig
  const expectedHostConfig = dockerCreateBody(plan).HostConfig
  return (
    typeof config === 'object' &&
    config !== null &&
    'Image' in config &&
    config.Image === plan.image &&
    'User' in config &&
    config.User === plan.user &&
    'Labels' in config &&
    labelsMatch(config.Labels, plan.labels) &&
    typeof hostConfig === 'object' &&
    hostConfig !== null &&
    typeof expectedHostConfig === 'object' &&
    expectedHostConfig !== null &&
    [
      'Privileged',
      'ReadonlyRootfs',
      'CapDrop',
      'SecurityOpt',
      'NetworkMode',
      'Binds',
      'PortBindings',
      'Memory',
      'NanoCpus',
      'PidsLimit',
      'LogConfig',
    ].every(
      (key) =>
        JSON.stringify(hostConfig[key as keyof typeof hostConfig]) ===
        JSON.stringify(expectedHostConfig[key as keyof typeof expectedHostConfig]),
    )
  )
}

export const validateBindSources = async (
  plan: DockerContainerPlan,
  trustedRoot = `/var/lib/gridora/servers/${plan.labels['dev.gridora.server'] ?? ''}`,
  trustedUids: ReadonlyArray<number> = [0, process.getuid?.() ?? 0],
  writableLeafUids: ReadonlyArray<number> = [10001],
): Promise<void> => {
  const root = await realpath(trustedRoot)
  if (root !== trustedRoot || (await lstat(trustedRoot)).isSymbolicLink())
    throw new DockerRuntimeError({
      code: 'rejected',
      message: 'trusted server root is not canonical',
    })
  const rootMetadata = await stat(root)
  if (!trustedUids.includes(rootMetadata.uid) || writableLeafUids.includes(rootMetadata.uid))
    throw new DockerRuntimeError({
      code: 'rejected',
      message: 'trusted server root has unsafe ownership',
    })
  if ((rootMetadata.mode & 0o022) !== 0)
    throw new DockerRuntimeError({
      code: 'rejected',
      message: 'trusted server root is writable by group or others',
    })
  for (const mount of plan.mounts) {
    const resolved = await realpath(mount.source)
    if (resolved !== root && !resolved.startsWith(`${root}/`))
      throw new DockerRuntimeError({
        code: 'rejected',
        message: 'bind source escapes trusted root',
      })
    let current = mount.source
    while (current !== trustedRoot && current.startsWith(`${trustedRoot}/`)) {
      const component = await lstat(current)
      if (component.isSymbolicLink())
        throw new DockerRuntimeError({
          code: 'rejected',
          message: 'bind source contains a symlink',
        })
      const isLeaf = current === mount.source
      if (
        !(isLeaf ? [...trustedUids, ...writableLeafUids] : trustedUids).includes(component.uid) ||
        (!isLeaf && writableLeafUids.includes(component.uid)) ||
        (!isLeaf && (component.mode & 0o022) !== 0)
      )
        throw new DockerRuntimeError({
          code: 'rejected',
          message: 'bind source parent can be replaced by an untrusted process',
        })
      current = dirname(current)
    }
    const metadata = await stat(resolved)
    if (![...trustedUids, ...writableLeafUids].includes(metadata.uid))
      throw new DockerRuntimeError({
        code: 'rejected',
        message: 'bind source has unsafe ownership',
      })
  }
}

export const validateDiskPolicy = (plan: DockerContainerPlan, proof: ProjectQuotaProof): void => {
  const serverId = plan.labels['dev.gridora.server'] ?? ''
  if (
    proof.apiVersion !== PROJECT_QUOTA_API_VERSION ||
    proof.enforced !== true ||
    proof.method !== plan.diskPolicy.method ||
    proof.serverId !== serverId ||
    proof.hardBytes !== plan.diskPolicy.requestedBytes ||
    proof.root !== `/var/lib/gridora/servers/${serverId}` ||
    !Number.isSafeInteger(proof.projectId) ||
    proof.projectId <= 0
  )
    throw new DockerRuntimeError({
      code: 'rejected',
      message: `disk quota ${plan.diskPolicy.requestedBytes} was not enforced for this server`,
    })
}

/** Only fixed Docker Engine operations are exposed; callers cannot supply API paths or commands. */
export const NodeDockerEngine = (
  socketPath: '/var/run/docker.sock' | '/run/docker.sock',
  quotaClient: ProjectQuotaClient = makeProjectQuotaClient(),
) =>
  Layer.succeed(DockerEngine, {
    apply: (plan) =>
      Effect.gen(function* () {
        const serverId = plan.labels['dev.gridora.server'] ?? ''
        const proof = yield* Effect.tryPromise({
          try: () =>
            quotaClient.ensure({
              apiVersion: PROJECT_QUOTA_API_VERSION,
              action: 'ensure',
              serverId,
              requestedBytes: plan.diskPolicy.requestedBytes,
              mountSources: plan.mounts.map((mount) => mount.source),
            }),
          catch: (cause) =>
            new DockerRuntimeError({
              code: 'rejected',
              message: `disk quota helper did not enforce the requested limit: ${
                cause instanceof Error ? cause.name : 'unknown error'
              }`,
            }),
        })
        yield* Effect.try({
          try: () => validateDiskPolicy(plan, proof),
          catch: (cause) =>
            cause instanceof DockerRuntimeError
              ? cause
              : new DockerRuntimeError({ code: 'rejected', message: String(cause) }),
        })
        yield* Effect.tryPromise({
          try: () => validateBindSources(plan),
          catch: (cause) =>
            cause instanceof DockerRuntimeError
              ? cause
              : new DockerRuntimeError({ code: 'rejected', message: String(cause) }),
        })
        const networkStatus = yield* dockerCall(
          socketPath,
          'POST',
          `/${DOCKER_API_VERSION}/networks/create`,
          dockerNetworkCreateBody(plan),
          [201, 409],
        )
        if (networkStatus === 409) {
          const network = yield* dockerInspect(
            socketPath,
            `/${DOCKER_API_VERSION}/networks/${encodeURIComponent(plan.network)}`,
          )
          if (!canAdoptNetwork(network, plan))
            return yield* Effect.fail(
              new DockerRuntimeError({ code: 'conflict', message: 'existing network is foreign' }),
            )
        }
        const createStatus = yield* dockerCall(
          socketPath,
          'POST',
          `/${DOCKER_API_VERSION}/containers/create?name=${encodeURIComponent(plan.name)}`,
          dockerCreateBody(plan),
          [201, 409],
        )
        if (createStatus === 409) {
          const container = yield* dockerInspect(
            socketPath,
            `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(plan.name)}/json`,
          )
          if (!canAdoptContainer(container, plan))
            return yield* Effect.fail(
              new DockerRuntimeError({
                code: 'conflict',
                message: 'existing container is foreign',
              }),
            )
        }
        yield* dockerCall(
          socketPath,
          'POST',
          `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(plan.name)}/start`,
          undefined,
          [204, 304],
        )
      }),
    start: (target) =>
      inspectOwned(socketPath, target).pipe(
        Effect.andThen(
          dockerCall(
            socketPath,
            'POST',
            `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(checkedServerName(target.serverId))}/start`,
            undefined,
            [204, 304],
          ).pipe(Effect.asVoid),
        ),
      ),
    stop: (target) =>
      inspectOwned(socketPath, target).pipe(
        Effect.andThen(
          dockerCall(
            socketPath,
            'POST',
            `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(checkedServerName(target.serverId))}/stop?t=60`,
            undefined,
            [204, 304],
          ).pipe(Effect.asVoid),
        ),
      ),
    remove: (target) =>
      inspectOwned(socketPath, target).pipe(
        Effect.andThen(
          dockerCall(
            socketPath,
            'DELETE',
            `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(checkedServerName(target.serverId))}?force=false&v=true`,
            undefined,
            [204, 404],
          ).pipe(Effect.asVoid),
        ),
      ),
  })

const inspectOwned = (
  socketPath: string,
  target: DockerTarget,
): Effect.Effect<void, DockerRuntimeError> =>
  dockerInspect(
    socketPath,
    `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(checkedServerName(target.serverId))}/json`,
  ).pipe(
    Effect.flatMap((container) => {
      const config = container.Config
      const labels =
        typeof config === 'object' && config !== null && 'Labels' in config
          ? config.Labels
          : undefined
      return labelsMatch(labels, {
        'dev.gridora.organization': target.organizationId,
        'dev.gridora.server': target.serverId,
        'dev.gridora.deployment': target.deploymentId,
      })
        ? Effect.void
        : Effect.fail(
            new DockerRuntimeError({
              code: 'conflict',
              message: 'container ownership labels do not match the signed command',
            }),
          )
    }),
  )

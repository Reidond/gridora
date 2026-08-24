import { lstat, readFile, realpath, statfs } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { arch, availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { dirname, relative, sep } from 'node:path'
import { request as httpRequest } from 'node:http'
import type { AgentObservationEvent } from '@gridora/agent-observation-control'
import { Effect, Layer, Schema } from 'effect'
import { AgentError } from './errors.js'
import { AgentObservationFactsProbe } from './observation.js'

const MAX_DOCKER_BYTES = 512 * 1024
const MAX_CONTAINERS = 128
const MAX_FIREWALL_PROOF_BYTES = 16 * 1024
export const FIREWALL_OBSERVATION_SOCKET = '/run/gridora/firewall-observation.sock' as const

const ImageAttestation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  imageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  imageVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  checksum: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  signatureVerified: Schema.Literal(true),
  buildIdentityManifestSha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  buildIdentitySignatureSha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  buildIdentityPublicKeySha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
})
const FirewallPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
const FirewallProof = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  defaultDeny: Schema.Boolean,
  allowedTcpPorts: Schema.Array(FirewallPort).check(Schema.isMaxLength(64)),
  allowedUdpPorts: Schema.Array(FirewallPort).check(Schema.isMaxLength(64)),
  rulesetSha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  ready: Schema.Boolean,
})

const unavailable = (component: string) =>
  new AgentError({
    code: 'execution-failed',
    message: `authoritative ${component} observation is unavailable`,
  })

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const dockerJson = (
  socketPath: '/var/run/docker.sock' | '/run/docker.sock',
  path: string,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      result: { readonly ok: true; readonly value: unknown } | { readonly ok: false },
    ) => {
      if (settled) return
      settled = true
      if (result.ok) resolve(result.value)
      else reject(new Error('docker observation failed'))
    }
    const request = httpRequest({ socketPath, method: 'GET', path, timeout: 5_000 }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_DOCKER_BYTES) {
          response.destroy()
          finish({ ok: false })
        } else chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200) return finish({ ok: false })
        try {
          finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          finish({ ok: false })
        }
      })
      response.on('aborted', () => finish({ ok: false }))
      response.on('error', () => finish({ ok: false }))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => finish({ ok: false }))
    request.end()
  })

/** @internal Test seam. Production uses the fixed root-owned evidence paths and UID zero. */
export const inspectImageAttestation = async (options: {
  readonly attestationPath: string
  readonly versionPath: string
  readonly expectedOwnerUid: number
}) => {
  const [attestationSource, installedVersion, attestationMetadata, versionMetadata] =
    await Promise.all([
      readFile(options.attestationPath, 'utf8'),
      readFile(options.versionPath, 'utf8'),
      lstat(options.attestationPath),
      lstat(options.versionPath),
    ])
  if (
    !attestationMetadata.isFile() ||
    !versionMetadata.isFile() ||
    attestationMetadata.uid !== options.expectedOwnerUid ||
    versionMetadata.uid !== options.expectedOwnerUid ||
    (attestationMetadata.mode & 0o022) !== 0 ||
    (versionMetadata.mode & 0o022) !== 0
  )
    throw new Error('image evidence is not root-owned and immutable to the agent')
  const attestation = await Schema.decodeUnknownPromise(ImageAttestation, {
    onExcessProperty: 'error',
  })(JSON.parse(attestationSource) as unknown)
  if (installedVersion.trim() !== attestation.imageVersion)
    throw new Error('installed image version does not match attestation')
  return {
    imageId: attestation.imageId,
    imageVersion: attestation.imageVersion,
    checksum: attestation.checksum,
    signatureVerified: true as const,
    buildIdentityManifestSha256: attestation.buildIdentityManifestSha256,
    buildIdentitySignatureSha256: attestation.buildIdentitySignatureSha256,
    buildIdentityPublicKeySha256: attestation.buildIdentityPublicKeySha256,
    ready: true,
  }
}

const inspectImage = () =>
  inspectImageAttestation({
    attestationPath: '/etc/gridora/image-attestation.json',
    versionPath: '/etc/gridora/image-version',
    expectedOwnerUid: 0,
  })

const inspectTunnel = async (): Promise<AgentObservationEvent['facts']['tunnel']> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch('http://127.0.0.1:20000/ready', {
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 200) return { state: 'connected', ready: true }
    return { state: 'degraded', ready: false }
  } catch {
    return { state: 'disconnected', ready: false }
  } finally {
    clearTimeout(timeout)
  }
}

const projectQuotaReady = async (): Promise<boolean> => {
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8')
  const rows = mountInfo.split('\n').filter((row) => row.includes(' /var/lib/gridora/servers '))
  if (rows.length !== 1) return false
  const fields = rows[0]?.split(' ')
  const separator = fields?.indexOf('-') ?? -1
  if (fields === undefined || separator < 0 || fields[separator + 1] !== 'ext4') return false
  const mountOptions = new Set([
    ...(fields[5]?.split(',') ?? []),
    ...(fields[separator + 3]?.split(',') ?? []),
  ])
  return mountOptions.has('prjquota') || mountOptions.has('project')
}

interface DockerObservation {
  readonly docker: AgentObservationEvent['facts']['docker']
  readonly containerRestarts: number
}

const inspectDocker = async (
  socketPath: '/var/run/docker.sock' | '/run/docker.sock',
): Promise<DockerObservation> => {
  const info = object(await dockerJson(socketPath, '/info'))
  if (
    info === undefined ||
    typeof info.ServerVersion !== 'string' ||
    info.ServerVersion.length < 1 ||
    info.ServerVersion.length > 64 ||
    info.Driver !== 'overlay2'
  )
    throw new Error('docker info is incompatible')
  const listed = await dockerJson(socketPath, `/containers/json?all=1&limit=${MAX_CONTAINERS + 1}`)
  if (!Array.isArray(listed) || listed.length > MAX_CONTAINERS)
    throw new Error('container inventory is unbounded')
  const ids = listed.map((entry) => object(entry)?.Id)
  if (ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id)))
    throw new Error('container inventory is invalid')
  let privilegedContainers = 0
  let dockerSocketMounted = false
  let containerRestarts = 0
  const dockerSocketRealPath = await realpath(socketPath)
  for (const id of ids as string[]) {
    const inspected = object(await dockerJson(socketPath, `/containers/${id}/json`))
    const hostConfig = object(inspected?.HostConfig)
    const mounts = inspected?.Mounts
    const restartCount = inspected?.RestartCount
    if (
      hostConfig === undefined ||
      typeof hostConfig.Privileged !== 'boolean' ||
      !Array.isArray(mounts) ||
      typeof restartCount !== 'number'
    )
      throw new Error('container inspection is invalid')
    if (hostConfig.Privileged) privilegedContainers += 1
    for (const mount of mounts) {
      const entry = object(mount)
      if (entry === undefined || typeof entry.Type !== 'string' || typeof entry.Source !== 'string')
        throw new Error('container mount inspection is invalid')
      if (entry.Type !== 'bind') continue
      const source = await realpath(entry.Source)
      const socketWithinSource = relative(source, dockerSocketRealPath)
      if (
        socketWithinSource === '' ||
        (!socketWithinSource.startsWith(`..${sep}`) && socketWithinSource !== '..')
      )
        dockerSocketMounted = true
    }
    if (!Number.isSafeInteger(restartCount) || restartCount < 0)
      throw new Error('restart count is unsafe')
    containerRestarts += restartCount
    if (!Number.isSafeInteger(containerRestarts)) throw new Error('restart count is unsafe')
  }
  const quotaReady = await projectQuotaReady()
  return {
    docker: {
      engineVersion: info.ServerVersion,
      storageDriver: 'overlay2',
      projectQuotaReady: quotaReady,
      privilegedContainers,
      dockerSocketMounted,
      ready: quotaReady && privilegedContainers === 0 && !dockerSocketMounted,
    },
    containerRestarts,
  }
}

const strictlySortedUnique = (values: ReadonlyArray<number>): boolean =>
  values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))

/** @internal Test seam. Production uses the fixed root-owned path and UID zero. */
export const inspectFirewallFromSocket = async (options: {
  readonly socketPath: string
  readonly expectedOwnerUid: number
}): Promise<AgentObservationEvent['facts']['firewall']> => {
  const [directoryMetadata, socketMetadata] = await Promise.all([
    lstat(dirname(options.socketPath)),
    lstat(options.socketPath),
  ])
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.uid !== options.expectedOwnerUid ||
    (directoryMetadata.mode & 0o022) !== 0 ||
    !socketMetadata.isSocket() ||
    socketMetadata.uid !== options.expectedOwnerUid ||
    (socketMetadata.mode & 0o777) !== 0o660
  )
    throw new Error('firewall observation socket metadata is unsafe')
  const source = await new Promise<string>((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks: Buffer[] = []
    const socket = createConnection(options.socketPath)
    const fail = () => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('firewall observation failed'))
    }
    socket.setTimeout(5_000, fail)
    socket.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_FIREWALL_PROOF_BYTES) fail()
      else chunks.push(chunk)
    })
    socket.on('end', () => {
      if (settled) return
      settled = true
      const value = Buffer.concat(chunks).toString('utf8')
      if (!value.endsWith('\n') || value.indexOf('\n') !== value.length - 1)
        return reject(new Error('firewall observation framing is invalid'))
      resolve(value.slice(0, -1))
    })
    socket.on('error', fail)
  })
  const proof = await Schema.decodeUnknownPromise(FirewallProof, { onExcessProperty: 'error' })(
    JSON.parse(source) as unknown,
  )
  if (
    proof.ready !== proof.defaultDeny ||
    !strictlySortedUnique(proof.allowedTcpPorts) ||
    !strictlySortedUnique(proof.allowedUdpPorts)
  )
    throw new Error('firewall observation proof is inconsistent')
  return {
    defaultDeny: proof.defaultDeny,
    allowedTcpPorts: [...proof.allowedTcpPorts],
    allowedUdpPorts: [...proof.allowedUdpPorts],
    ready: proof.ready,
  }
}

const inspectFirewall = () =>
  inspectFirewallFromSocket({ socketPath: FIREWALL_OBSERVATION_SOCKET, expectedOwnerUid: 0 })

const networkCounters = async (): Promise<{
  readonly receive: number
  readonly transmit: number
}> => {
  const source = await readFile('/proc/net/dev', 'utf8')
  let receive = 0
  let transmit = 0
  for (const line of source.split('\n').slice(2)) {
    const [name, values] = line.split(':')
    if (name === undefined || values === undefined || name.trim() === 'lo') continue
    const fields = values.trim().split(/\s+/)
    const received = Number(fields[0])
    const transmitted = Number(fields[8])
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(transmitted))
      throw new Error('network counter is unsafe')
    receive += received
    transmit += transmitted
  }
  if (!Number.isSafeInteger(receive) || !Number.isSafeInteger(transmit))
    throw new Error('network aggregate is unsafe')
  return { receive, transmit }
}

export const NodeAgentObservationFacts = (input: {
  readonly version: string
  readonly dockerSocket: '/var/run/docker.sock' | '/run/docker.sock'
}) =>
  Layer.succeed(AgentObservationFactsProbe, {
    inspect: Effect.tryPromise({
      try: async () => {
        if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(input.version))
          throw new Error('agent version is invalid')
        const [image, tunnel, observedDocker, firewall, disk, network] = await Promise.all([
          inspectImage(),
          inspectTunnel(),
          inspectDocker(input.dockerSocket),
          inspectFirewall(),
          statfs('/var/lib/gridora/servers', { bigint: true }),
          networkCounters(),
        ])
        const cpus = availableParallelism()
        const cpuMillis = cpus * 1_000
        const ramBytes = totalmem()
        const diskBytesBig = disk.blocks * BigInt(disk.bsize)
        const diskAvailableBig = disk.bavail * BigInt(disk.bsize)
        if (
          !Number.isSafeInteger(cpuMillis) ||
          cpuMillis <= 0 ||
          !Number.isSafeInteger(ramBytes) ||
          ramBytes <= 0 ||
          diskBytesBig <= 0 ||
          diskBytesBig > BigInt(Number.MAX_SAFE_INTEGER) ||
          diskAvailableBig < 0 ||
          diskAvailableBig > diskBytesBig
        )
          throw new Error('capacity is unsafe')
        const architecture = arch()
        if (architecture !== 'x64' && architecture !== 'arm64')
          throw new Error('architecture is unsupported')
        const load = Math.max(0, loadavg()[0] ?? 0)
        return {
          agent: { version: input.version, ready: true },
          image,
          tunnel,
          docker: observedDocker.docker,
          firewall,
          capacity: {
            architecture: architecture === 'x64' ? ('amd64' as const) : ('arm64' as const),
            cpuMillis,
            ramBytes,
            diskBytes: Number(diskBytesBig),
            cpuUsedMillis: Math.min(cpuMillis, Math.round(load * 1_000)),
            ramUsedBytes: ramBytes - freemem(),
            diskUsedBytes: Number(diskBytesBig - diskAvailableBig),
          },
          metrics: {
            loadPermille: Math.min(100_000, Math.round((load / cpus) * 1_000)),
            networkReceiveBytes: network.receive,
            networkTransmitBytes: network.transmit,
            containerRestarts: observedDocker.containerRestarts,
          },
        }
      },
      catch: () => unavailable('node'),
    }),
  })

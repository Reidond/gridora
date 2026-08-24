import { statfs } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import {
  FetchAgentTelemetryTransport,
  makeDurableTelemetryPublisher,
  prepareAgentHealthSample,
  type AgentHealthSample,
  type AgentServerHealthSample,
} from '@gridora/agent-telemetry'
import { makeFileDurableLogSpoolStorage } from '@gridora/agent-telemetry/file-spool'
import { Effect } from 'effect'
import type { AgentConfiguration } from './config.js'
import type { NodeAuthentication } from './transport.js'

const maximumDockerBytes = 512 * 1024
const maximumContainers = 128
const containerId = /^[a-f0-9]{12,64}$/
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const dockerJson = (
  socketPath: AgentConfiguration['dockerSocket'],
  path: string,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: unknown, failed = false) => {
      if (settled) return
      settled = true
      if (failed) reject(new Error('docker telemetry inspection failed'))
      else resolve(value)
    }
    const request = httpRequest({ socketPath, method: 'GET', path, timeout: 5_000 }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maximumDockerBytes) {
          response.destroy()
          finish(undefined, true)
        } else chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200) return finish(undefined, true)
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        } catch {
          finish(undefined, true)
        }
      })
      response.on('aborted', () => finish(undefined, true))
      response.on('error', () => finish(undefined, true))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => finish(undefined, true))
    request.end()
  })

const containerState = (value: unknown): AgentHealthSample['containers'][number]['state'] =>
  typeof value === 'string' &&
  ['created', 'running', 'paused', 'restarting', 'exited', 'dead'].includes(value)
    ? (value as AgentHealthSample['containers'][number]['state'])
    : 'unknown'

const containerHealth = (value: unknown): AgentHealthSample['containers'][number]['health'] => {
  if (typeof value !== 'string') return 'none'
  const normalized = value.toLowerCase()
  if (normalized.includes('unhealthy')) return 'unhealthy'
  if (normalized.includes('healthy')) return 'healthy'
  if (normalized.includes('starting')) return 'starting'
  return 'none'
}

const inspectTunnel = async (): Promise<AgentHealthSample['tunnel']> => {
  try {
    const response = await fetch('http://127.0.0.1:20000/ready', {
      redirect: 'error',
      signal: AbortSignal.timeout(3_000),
    })
    return response.status === 200 ? 'connected' : 'degraded'
  } catch {
    return 'offline'
  }
}

const inspectTelemetryFacts = async (
  config: AgentConfiguration,
): Promise<{
  readonly health: AgentHealthSample
  readonly serverHealth: ReadonlyArray<AgentServerHealthSample>
}> => {
  const sampledAt = new Date().toISOString()
  const [tunnel, filesystem, listed] = await Promise.all([
    inspectTunnel(),
    statfs('/var/lib/gridora/servers', { bigint: true }),
    dockerJson(config.dockerSocket, `/containers/json?all=1&limit=${maximumContainers + 1}`).catch(
      () => undefined,
    ),
  ])
  const diskTotal = filesystem.blocks * BigInt(filesystem.bsize)
  const diskAvailable = filesystem.bavail * BigInt(filesystem.bsize)
  if (
    diskTotal <= 0 ||
    diskTotal > BigInt(Number.MAX_SAFE_INTEGER) ||
    diskAvailable < 0 ||
    diskAvailable > diskTotal
  )
    throw new Error('telemetry disk capacity is invalid')
  const source = Array.isArray(listed) && listed.length <= maximumContainers ? listed : []
  const containers: Array<AgentHealthSample['containers'][number]> = []
  const serverHealth: AgentServerHealthSample[] = []
  for (const value of source) {
    const row = object(value)
    if (row === undefined) continue
    const id = typeof row.Id === 'string' ? row.Id : undefined
    const names = Array.isArray(row.Names) ? row.Names : []
    const name = typeof names[0] === 'string' ? names[0].replace(/^\//, '') : undefined
    if (
      id === undefined ||
      !containerId.test(id) ||
      name === undefined ||
      name.length === 0 ||
      name.length > 128
    )
      continue
    const state = containerState(row.State)
    const health = containerHealth(row.Status)
    const sample = {
      id,
      name,
      state,
      health,
      restartCount: 0,
      cpuUsedMillis: 0,
      memoryUsedBytes: 0,
    } as const
    containers.push(sample)
    const labels = object(row.Labels)
    const organizationId =
      labels === undefined || typeof labels['dev.gridora.organization'] !== 'string'
        ? undefined
        : labels['dev.gridora.organization']
    const serverId =
      labels === undefined || typeof labels['dev.gridora.server'] !== 'string'
        ? undefined
        : labels['dev.gridora.server']
    const deploymentId =
      labels === undefined || typeof labels['dev.gridora.deployment'] !== 'string'
        ? undefined
        : labels['dev.gridora.deployment']
    // These labels are written by the fixed Docker deployment plan. The API
    // still resolves deployment ownership authoritatively; labels only bind a
    // sampled container to the agent's observed game/plugin process.
    if (
      organizationId !== config.organizationId ||
      serverId === undefined ||
      deploymentId === undefined ||
      !identifierPattern.test(serverId) ||
      !identifierPattern.test(deploymentId)
    )
      continue
    serverHealth.push({
      serverId,
      deploymentId,
      containerId: id,
      game: {
        process: state === 'running' ? 'running' : state === 'unknown' ? 'unknown' : 'stopped',
        // Images with a Docker healthcheck expose the plugin/game query result
        // here; otherwise the agent reports `unknown` rather than inventing a
        // game-level success from a process-only observation.
        query: health === 'healthy' ? 'healthy' : health === 'unhealthy' ? 'unhealthy' : 'unknown',
        mods: 'unknown',
      },
    })
  }
  const cpus = availableParallelism()
  const cpuTotalMillis = cpus * 1_000
  const load = Math.max(0, loadavg()[0] ?? 0)
  const ramTotalBytes = totalmem()
  const ramUsedBytes = Math.max(0, ramTotalBytes - freemem())
  const health = await Effect.runPromise(
    prepareAgentHealthSample({
      organizationId: config.organizationId,
      nodeId: config.nodeId,
      sampledAt,
      agentVersion: config.agentVersion,
      tunnel,
      docker: Array.isArray(listed) ? 'healthy' : 'offline',
      firewall: 'unknown',
      cpuUsedMillis: Math.min(cpuTotalMillis, Math.round(load * 1_000)),
      cpuTotalMillis,
      ramUsedBytes,
      ramTotalBytes,
      diskUsedBytes: Number(diskTotal - diskAvailable),
      diskTotalBytes: Number(diskTotal),
      loadPermille: Math.min(100_000, Math.round((load / Math.max(1, cpus)) * 1_000)),
      networkReceiveBytes: 0,
      networkTransmitBytes: 0,
      containers,
    }),
  )
  return { health, serverHealth }
}

/**
 * Production authenticated telemetry loop. The file contains both the bounded
 * redacted log spool and the exact prepared payload, so a post-send timeout or
 * a renewed credential can only replay the same receipt range.
 */
export const makeProductionTelemetryPublisher = (config: AgentConfiguration) => {
  const publisher = makeDurableTelemetryPublisher(
    makeFileDurableLogSpoolStorage({
      directory: config.stateDirectory,
      fileName: 'telemetry.spool.json',
    }),
    FetchAgentTelemetryTransport(
      config.controlPlaneUrl,
      config.expectedControlPlaneHost,
      config.allowLoopbackHttp,
    ),
  )
  return {
    publishOnce: (authentication: NodeAuthentication) =>
      Effect.gen(function* () {
        const facts = yield* Effect.tryPromise({
          try: () => inspectTelemetryFacts(config),
          catch: () => new Error('agent telemetry facts are unavailable'),
        }).pipe(Effect.mapError(() => new Error('agent telemetry facts are unavailable')))
        return yield* publisher.publishOnce(
          authentication.nodeCredential,
          facts.health,
          facts.serverHealth,
        )
      }),
    append: publisher.append,
    pending: publisher.pending,
  }
}

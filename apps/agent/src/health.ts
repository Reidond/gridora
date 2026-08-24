export interface AgentHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy'
  readonly version: string
  readonly organizationId: string
  readonly nodeId: string
  readonly docker: { readonly reachable: boolean; readonly version?: string }
  readonly disk: { readonly availableBytes: number; readonly totalBytes: number }
  readonly checkedAt: string
}

/** Shared recursive redaction keeps agent logs and durable telemetry bytes aligned. */
export const redact = (value: unknown): unknown => redactSecrets(value)

export const healthStatus = (input: Omit<AgentHealth, 'status'>): AgentHealth => ({
  ...input,
  status: !input.docker.reachable
    ? 'unhealthy'
    : input.disk.totalBytes <= 0 || input.disk.availableBytes < 0
      ? 'unhealthy'
      : input.disk.availableBytes / input.disk.totalBytes < 0.1
        ? 'degraded'
        : 'healthy',
})

export class NodeHealthProbe extends Context.Service<
  NodeHealthProbe,
  { readonly inspect: Effect.Effect<AgentHealth> }
>()('gridora/agent/NodeHealthProbe') {}

const dockerHealth = (
  socketPath: '/var/run/docker.sock' | '/run/docker.sock',
): Promise<AgentHealth['docker']> =>
  new Promise((resolveHealth) => {
    const request = httpRequest(
      { socketPath, method: 'GET', path: '/version', timeout: 5_000 },
      (response) => {
        let size = 0
        let settled = false
        const chunks: Buffer[] = []
        const finish = (health: AgentHealth['docker']) => {
          if (settled) return
          settled = true
          resolveHealth(health)
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > 64 * 1024) {
            finish({ reachable: false })
            response.destroy()
          } else chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) return finish({ reachable: false })
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              Version?: unknown
            }
            finish(
              typeof parsed.Version === 'string'
                ? { reachable: true, version: parsed.Version.slice(0, 64) }
                : { reachable: true },
            )
          } catch {
            finish({ reachable: false })
          }
        })
        response.on('aborted', () => finish({ reachable: false }))
        response.on('error', () => finish({ reachable: false }))
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolveHealth({ reachable: false }))
    request.end()
  })

const diskHealth = async (): Promise<AgentHealth['disk']> => {
  try {
    const disk = await statfs('/var/lib/gridora', { bigint: true })
    const available = disk.bavail * BigInt(disk.bsize)
    const total = disk.blocks * BigInt(disk.bsize)
    if (available > BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER))
      return { availableBytes: 0, totalBytes: 0 }
    return { availableBytes: Number(available), totalBytes: Number(total) }
  } catch {
    return { availableBytes: 0, totalBytes: 0 }
  }
}

export const NodeHealthProbeLive = (input: {
  readonly version: string
  readonly organizationId: string
  readonly nodeId: string
  readonly dockerSocket: '/var/run/docker.sock' | '/run/docker.sock'
}) =>
  Layer.succeed(NodeHealthProbe, {
    inspect: Effect.tryPromise(async () => {
      const [docker, disk] = await Promise.all([dockerHealth(input.dockerSocket), diskHealth()])
      return healthStatus({
        version: input.version,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        docker,
        disk,
        checkedAt: new Date().toISOString(),
      })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          healthStatus({
            version: input.version,
            organizationId: input.organizationId,
            nodeId: input.nodeId,
            docker: { reachable: false },
            disk: { availableBytes: 0, totalBytes: 0 },
            checkedAt: new Date().toISOString(),
          }),
        ),
      ),
    ),
  })
import { statfs } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { Context, Effect, Layer } from 'effect'
import { redactSecrets } from '@gridora/log-control'

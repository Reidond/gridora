import { lookup } from 'node:dns/promises'
import { createConnection } from 'node:net'
import { Effect, Schema } from 'effect'
import { AgentError } from './errors.js'

export const PLUGIN_EGRESS_LEASE_SOCKET = '/run/gridora/plugin-egress-lease.sock' as const

export interface PluginEgressEntry {
  readonly address: string
  readonly protocol: 'tcp' | 'udp'
  readonly port: number
}

export interface PluginEgressLease {
  readonly release: Effect.Effect<void, never>
}

export interface PluginEgressLeaseManager {
  readonly acquire: (
    leaseId: string,
    destinations: readonly string[],
  ) => Effect.Effect<PluginEgressLease, AgentError>
}

export type PluginEgressResolver = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly { readonly address: string; readonly family: number }[]>

const responseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  leaseId: Schema.String,
  applied: Schema.Literal(true),
})

const failure = (message: string) => new AgentError({ code: 'execution-failed', message })

const publicIpv4 = (address: string): boolean => {
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false
  const [a, b, c] = octets as [number, number, number, number]
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

const reviewedPorts: readonly { readonly protocol: 'tcp' | 'udp'; readonly port: number }[] = [
  { protocol: 'tcp', port: 80 },
  { protocol: 'tcp', port: 443 },
  ...Array.from({ length: 36 }, (_, index) => ({
    protocol: 'tcp' as const,
    port: 27_015 + index,
  })),
  ...Array.from({ length: 22 }, (_, index) => ({
    protocol: 'udp' as const,
    port: 27_015 + index,
  })),
]

export const resolvePluginEgressEntries = async (
  destinations: readonly string[],
  resolver: PluginEgressResolver = (hostname, options) => lookup(hostname, options),
): Promise<readonly PluginEgressEntry[]> => {
  const hosts = [...new Set(destinations.map((host) => host.toLowerCase()))].sort()
  if (
    hosts.length > 16 ||
    hosts.some(
      (host) =>
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host,
        ),
    )
  )
    throw new Error('plugin egress destination is not a canonical hostname')
  const addresses = new Set<string>()
  for (const host of hosts) {
    const resolved = await resolver(host, { all: true, verbatim: true })
    if (
      resolved.length === 0 ||
      resolved.length > 16 ||
      resolved.some((entry) => entry.family !== 4)
    )
      throw new Error('plugin egress destination did not resolve to a bounded IPv4 set')
    if (resolved.some((entry) => !publicIpv4(entry.address)))
      throw new Error('plugin egress destination resolved to a private or reserved address')
    for (const entry of resolved) addresses.add(entry.address)
  }
  const entries = [...addresses]
    .sort()
    .flatMap((address) => reviewedPorts.map((entry) => ({ address, ...entry })))
  if (entries.length > 1024) throw new Error('plugin egress lease is too large')
  return entries
}

const exchange = async (
  socketPath: string,
  request: Readonly<Record<string, unknown>>,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) reject(error)
      else {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        } catch {
          reject(new Error('plugin egress helper returned invalid JSON'))
        }
      }
    }
    socket.setTimeout(35_000, () => finish(new Error('plugin egress helper timed out')))
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 16 * 1024) finish(new Error('plugin egress helper response is too large'))
      else chunks.push(chunk)
    })
    socket.on('end', () => finish())
    socket.on('error', (cause) => finish(cause))
  })

export const NodePluginEgressLeaseManager = (
  socketPath = PLUGIN_EGRESS_LEASE_SOCKET,
): PluginEgressLeaseManager => ({
  acquire: (leaseId, destinations) =>
    destinations.length === 0
      ? Effect.succeed({ release: Effect.void })
      : Effect.tryPromise({
          try: async () => {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(leaseId))
              throw new Error('plugin egress lease identity is unsafe')
            const entries = await resolvePluginEgressEntries(destinations)
            const acquired = await Schema.decodeUnknownPromise(responseSchema, {
              onExcessProperty: 'error',
            })(
              await exchange(socketPath, {
                schemaVersion: 1,
                action: 'acquire',
                leaseId,
                entries,
              }),
            )
            if (acquired.leaseId !== leaseId)
              throw new Error('plugin egress helper returned a foreign lease')
            return {
              release: Effect.tryPromise({
                try: async () => {
                  const released = await Schema.decodeUnknownPromise(responseSchema, {
                    onExcessProperty: 'error',
                  })(
                    await exchange(socketPath, {
                      schemaVersion: 1,
                      action: 'release',
                      leaseId,
                      entries,
                    }),
                  )
                  if (released.leaseId !== leaseId)
                    throw new Error('plugin egress helper returned a foreign release')
                },
                catch: () => failure('plugin egress lease release failed'),
              }).pipe(Effect.ignore),
            }
          },
          catch: (cause) =>
            failure(
              `plugin egress lease acquisition failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
        }),
})

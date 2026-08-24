import { Context, Effect, Schema } from 'effect'

export interface PortRequest {
  readonly protocol: 'tcp' | 'udp'
  readonly preferredPort?: number
  readonly count?: number
  readonly name: string
}
export interface PortLease {
  readonly protocol: 'tcp' | 'udp'
  readonly port: number
  readonly name: string
}
export interface ResourceQuantity {
  readonly cpu: number
  readonly memoryMiB: number
  readonly diskGiB: number
}
export interface SchedulerNode {
  readonly id: string
  readonly organizationId: string
  readonly provider: string
  readonly region: string
  readonly architecture: 'amd64' | 'arm64'
  readonly allocatable: ResourceQuantity
  readonly reserved: ResourceQuantity
  readonly drain: boolean
  readonly labels: Readonly<Record<string, string>>
  readonly portLeases: readonly PortLease[]
  readonly deploymentIds: readonly string[]
  readonly cachedSteamAppIds: readonly number[]
  readonly estimatedMarginalCost: number
  readonly agentVersion: string
  readonly pluginVersions: Readonly<Record<string, string>>
}
export interface PlacementRequest {
  readonly organizationId: string
  readonly deploymentId: string
  readonly operationId: string
  readonly mode: 'auto' | 'shared' | 'dedicated' | 'pinned'
  readonly pinnedNodeId?: string
  readonly resources: ResourceQuantity
  readonly ports: readonly PortRequest[]
  readonly architecture: 'amd64' | 'arm64'
  readonly pluginId: string
  readonly pluginVersion: string
  readonly steamAppId?: number
  readonly preferredProvider?: string
  readonly preferredRegion?: string
  readonly requiredLabels?: Readonly<Record<string, string>>
  readonly antiAffinityDeploymentIds?: readonly string[]
  readonly maximumEstimatedCost?: number
}
export class PlacementRejectedError extends Schema.TaggedError<PlacementRejectedError>()(
  'PlacementRejectedError',
  { message: Schema.String, explanations: Schema.Array(Schema.String) },
) {}
export class ReservationConflictError extends Schema.TaggedError<ReservationConflictError>()(
  'ReservationConflictError',
  { nodeId: Schema.String, message: Schema.String },
) {}
export type SchedulerError = PlacementRejectedError | ReservationConflictError
export interface ReservationResult {
  readonly nodeId: string
  readonly capacity: ResourceQuantity
  readonly ports: readonly PortLease[]
  readonly reservationId: string
}
export interface ReservationStoreShape {
  /** Atomically checks revision/capacity/ports and inserts both capacity and port leases. */
  readonly reserve: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly deploymentId: string
    readonly operationId: string
    readonly capacity: ResourceQuantity
    readonly ports: readonly PortLease[]
  }) => Effect.Effect<ReservationResult, ReservationConflictError>
  readonly release: (input: {
    readonly organizationId: string
    readonly reservationId: string
    readonly operationId: string
  }) => Effect.Effect<void, ReservationConflictError>
}
export class ReservationStore extends Context.Service<ReservationStore, ReservationStoreShape>()(
  '@gridora/scheduler/ReservationStore',
) {}
export interface CandidateExplanation {
  readonly nodeId: string
  readonly accepted: boolean
  readonly reasons: readonly string[]
  readonly score: number
  readonly factors: Readonly<Record<string, number>>
}
export interface PlacementDecision {
  readonly kind: 'existing'
  readonly reservation: ReservationResult
  readonly explanation: string
  readonly candidates: readonly CandidateExplanation[]
}
export interface ProvisionRequired {
  readonly kind: 'provision'
  readonly explanation: string
  readonly candidates: readonly CandidateExplanation[]
}

const available = (node: SchedulerNode): ResourceQuantity => ({
  cpu: node.allocatable.cpu - node.reserved.cpu,
  memoryMiB: node.allocatable.memoryMiB - node.reserved.memoryMiB,
  diskGiB: node.allocatable.diskGiB - node.reserved.diskGiB,
})
const allocatePorts = (
  node: SchedulerNode,
  requests: readonly PortRequest[],
): readonly PortLease[] | undefined => {
  const used = new Set(node.portLeases.map((p) => `${p.protocol}:${p.port}`))
  const out: PortLease[] = []
  for (const request of requests) {
    const count = request.count ?? 1
    for (let offset = 0; offset < count; offset++) {
      let port = request.preferredPort === undefined ? 20000 : request.preferredPort + offset
      while (
        used.has(`${request.protocol}:${port}`) &&
        request.preferredPort === undefined &&
        port <= 65535
      )
        port++
      if (port > 65535 || used.has(`${request.protocol}:${port}`)) return undefined
      used.add(`${request.protocol}:${port}`)
      out.push({
        protocol: request.protocol,
        port,
        name: count === 1 ? request.name : `${request.name}-${offset + 1}`,
      })
    }
  }
  return out
}
export const evaluateCandidate = (
  node: SchedulerNode,
  request: PlacementRequest,
): CandidateExplanation & { readonly ports?: readonly PortLease[] } => {
  const reasons: string[] = []
  const free = available(node)
  if (node.organizationId !== request.organizationId) reasons.push('organization mismatch')
  if (node.drain) reasons.push('node is draining')
  if (node.architecture !== request.architecture) reasons.push('architecture mismatch')
  if (request.mode === 'pinned' && node.id !== request.pinnedNodeId) reasons.push('not pinned node')
  if (
    request.mode === 'dedicated' &&
    (node.reserved.cpu > 0 ||
      node.reserved.memoryMiB > 0 ||
      node.reserved.diskGiB > 0 ||
      node.portLeases.length > 0 ||
      node.deploymentIds.length > 0)
  )
    reasons.push('dedicated placement requires empty node')
  if ((request.antiAffinityDeploymentIds ?? []).some((id) => node.deploymentIds.includes(id)))
    reasons.push('anti-affinity deployment is present')
  if (free.cpu < request.resources.cpu) reasons.push('insufficient cpu')
  if (free.memoryMiB < request.resources.memoryMiB) reasons.push('insufficient memory')
  if (free.diskGiB < request.resources.diskGiB) reasons.push('insufficient disk')
  if (node.pluginVersions[request.pluginId] !== request.pluginVersion)
    reasons.push('plugin version unavailable')
  if (
    request.maximumEstimatedCost !== undefined &&
    node.estimatedMarginalCost > request.maximumEstimatedCost
  )
    reasons.push('cost exceeds maximum')
  for (const [key, value] of Object.entries(request.requiredLabels ?? {}))
    if (node.labels[key] !== value) reasons.push(`label ${key} mismatch`)
  const ports = allocatePorts(node, request.ports)
  if (ports === undefined) reasons.push('required port unavailable')
  const factors = {
    provider: node.provider === request.preferredProvider ? 20 : 0,
    region: node.region === request.preferredRegion ? 15 : 0,
    cache:
      request.steamAppId !== undefined && node.cachedSteamAppIds.includes(request.steamAppId)
        ? 10
        : 0,
    headroom: Math.max(0, free.memoryMiB - request.resources.memoryMiB) / 1024,
    cost: -node.estimatedMarginalCost,
  }
  return {
    nodeId: node.id,
    accepted: reasons.length === 0,
    reasons,
    score: Object.values(factors).reduce((a, b) => a + b, 0),
    factors,
    ...(ports === undefined ? {} : { ports }),
  }
}
export const schedule = (
  request: PlacementRequest,
  nodes: readonly SchedulerNode[],
  store: ReservationStoreShape,
  allowProvision: boolean,
): Effect.Effect<PlacementDecision | ProvisionRequired, SchedulerError> => {
  const candidates = nodes
    .map((n) => evaluateCandidate(n, request))
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
  const winner = candidates.find((c) => c.accepted)
  if (winner === undefined)
    return allowProvision
      ? Effect.succeed({
          kind: 'provision',
          explanation: 'No existing node fits; provider provisioning is required',
          candidates,
        })
      : Effect.fail(
          new PlacementRejectedError({
            message: 'no eligible node',
            explanations: candidates.flatMap((c) => c.reasons.map((r) => `${c.nodeId}: ${r}`)),
          }),
        )
  return Effect.map(
    store.reserve({
      organizationId: request.organizationId,
      nodeId: winner.nodeId,
      deploymentId: request.deploymentId,
      operationId: request.operationId,
      capacity: request.resources,
      ports: winner.ports ?? [],
    }),
    (reservation): PlacementDecision => ({
      kind: 'existing',
      reservation,
      explanation: `Selected ${winner.nodeId} with score ${winner.score.toFixed(2)}; ${Object.entries(
        winner.factors,
      )
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(', ')}`,
      candidates,
    }),
  )
}

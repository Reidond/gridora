import type { RealtimeTicketClaims } from './ticket.js'
import {
  canonicalCommandPayload,
  canonicalJson,
  type AgentCommand,
  type CommandResult,
} from '@gridora/agent-protocol'

export const sameCommandPayload = (left: AgentCommand, right: AgentCommand): boolean =>
  canonicalCommandPayload(left) === canonicalCommandPayload(right)

export const validCommandResult = (command: AgentCommand, result: CommandResult): boolean => {
  if (result.commandId !== command.commandId || result.operationId !== command.operationId)
    return false
  if (command.type === 'health.inspect')
    return result.status === 'succeeded' ? result.revision === null : true
  return result.status === 'succeeded'
    ? result.revision !== null &&
        (command.expectedPriorRevision === null
          ? result.revision >= 0
          : result.revision === command.expectedPriorRevision + 1)
    : true
}

export const sameCommandResult = (left: CommandResult, right: CommandResult): boolean =>
  canonicalJson(left) === canonicalJson(right)

export const contiguousResultWatermark = (
  previous: number,
  completedSequences: ReadonlyArray<number>,
): number => {
  const completed = new Set(completedSequences)
  let watermark = previous
  while (completed.has(watermark + 1)) watermark += 1
  return watermark
}

export const validNodeAgentClaims = (
  claims: RealtimeTicketClaims,
  nodeId: string,
  sessionVersion: number,
): boolean =>
  claims.audience === 'node-agent' &&
  claims.resourceType === 'node' &&
  claims.resourceId === nodeId &&
  claims.machineId === nodeId &&
  claims.sessionVersion === sessionVersion

export interface RevocationEvent {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

export const closeSocketsForMembershipRevocation = (
  event: RevocationEvent,
  socketsForTag: (
    tag: string,
  ) => ReadonlyArray<{ readonly close: (code?: number, reason?: string) => void }>,
): number => {
  if (
    event.type !== 'organization.membership.revoked' &&
    event.type !== 'organization.membership.left'
  )
    return 0
  const principalId = event.data.principalId
  if (typeof principalId !== 'string') return 0
  const sockets = socketsForTag(`principal:${principalId}`)
  for (const socket of sockets) socket.close(4003, 'membership revoked')
  return sockets.length
}

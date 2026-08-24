import { describe, expect, it, vi } from 'vitest'
import {
  closeSocketsForMembershipRevocation,
  contiguousResultWatermark,
  sameCommandPayload,
  sameCommandResult,
  validCommandResult,
  validNodeAgentClaims,
} from '../src/coordinator-invariants.js'

describe('realtime coordinator invariants', () => {
  it('preserves an out-of-order result until the contiguous watermark catches up', () => {
    expect(contiguousResultWatermark(0, [2])).toBe(0)
    expect(contiguousResultWatermark(0, [2, 1])).toBe(2)
  })

  it('accepts only a node-agent ticket for the current machine session', () => {
    const claims = {
      organizationId: 'org_1',
      principalId: 'machine_identity_1',
      audience: 'node-agent' as const,
      resourceType: 'node' as const,
      resourceId: 'node_1',
      machineId: 'node_1',
      sessionVersion: 3,
      expiresAt: Date.now() + 60_000,
      nonce: 'nonce_1',
    }
    expect(validNodeAgentClaims(claims, 'node_1', 3)).toBe(true)
    expect(validNodeAgentClaims({ ...claims, audience: 'console' }, 'node_1', 3)).toBe(false)
    expect(validNodeAgentClaims({ ...claims, sessionVersion: 2 }, 'node_1', 3)).toBe(false)
  })

  it('closes every active socket when a principal is removed or leaves', () => {
    for (const type of ['organization.membership.revoked', 'organization.membership.left']) {
      const first = { close: vi.fn() }
      const second = { close: vi.fn() }
      const count = closeSocketsForMembershipRevocation(
        {
          type,
          data: { principalId: 'identity_1' },
        },
        (tag) => (tag === 'principal:identity_1' ? [first, second] : []),
      )
      expect(count).toBe(2)
      expect(first.close).toHaveBeenCalledWith(4003, 'membership revoked')
      expect(second.close).toHaveBeenCalledWith(4003, 'membership revoked')
    }
  })

  it('rejects an idempotency-key replay when the signed command payload changes', () => {
    const command = {
      apiVersion: 'agent.gridora.dev/v1alpha1' as const,
      commandId: 'command_1',
      operationId: 'operation_1',
      organizationId: 'org_1',
      nodeId: 'node_1',
      resourceId: 'server_1',
      type: 'server.start' as const,
      payloadSchemaVersion: 1 as const,
      issuedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2026-08-23T00:05:00.000Z',
      idempotencyKey: 'key_1',
      expectedPriorRevision: 1,
      payload: { deploymentId: 'deployment_1' },
      signature: 'a'.repeat(64),
    }
    expect(sameCommandPayload(command, { ...command, signature: 'b'.repeat(64) })).toBe(true)
    expect(
      sameCommandPayload(command, { ...command, payload: { deploymentId: 'deployment_2' } }),
    ).toBe(false)
    const result = {
      commandId: command.commandId,
      operationId: command.operationId,
      status: 'succeeded' as const,
      revision: 2,
      code: 'completed',
      message: 'done',
      duplicate: false,
      completedAt: '2026-08-23T00:01:00.000Z',
    }
    expect(validCommandResult(command, result)).toBe(true)
    expect(validCommandResult(command, { ...result, operationId: 'operation_other' })).toBe(false)
    expect(validCommandResult(command, { ...result, revision: 1 })).toBe(false)
    expect(sameCommandResult(result, { ...result })).toBe(true)
    expect(sameCommandResult(result, { ...result, message: 'conflicting terminal replay' })).toBe(
      false,
    )
    const healthCommand = {
      ...command,
      type: 'health.inspect' as const,
      expectedPriorRevision: null,
    }
    expect(validCommandResult(healthCommand, { ...result, revision: null })).toBe(true)
    expect(validCommandResult(healthCommand, result)).toBe(false)
    expect(validCommandResult(command, { ...result, status: 'rejected', revision: 7 })).toBe(true)
    expect(
      validCommandResult(
        { ...command, expectedPriorRevision: null },
        {
          ...result,
          status: 'failed',
          revision: 4,
        },
      ),
    ).toBe(true)
  })
})

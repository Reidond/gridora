import { describe, expect, it } from 'vitest'

import {
  type ContractInstance,
  type ProviderContractDriver,
  verifyLifecycle,
  verifyLostResponseAdoption,
} from './provider-contract'

const fakeDriver = (): ProviderContractDriver => {
  const byOperation = new Map<string, ContractInstance>()
  return {
    create: async ({ operationId }) => {
      const current = byOperation.get(operationId)
      if (current) return current
      const created = {
        id: `instance-${byOperation.size + 1}`,
        operationId,
        state: 'running',
      } as const
      byOperation.set(operationId, created)
      return created
    },
    findByOperationId: async (operationId) => byOperation.get(operationId),
    start: async (id) => {
      for (const [operationId, value] of byOperation) {
        if (value.id === id) byOperation.set(operationId, { ...value, state: 'running' })
      }
    },
    stop: async (id) => {
      for (const [operationId, value] of byOperation) {
        if (value.id === id) byOperation.set(operationId, { ...value, state: 'stopped' })
      }
    },
    retire: async (id) => {
      for (const [operationId, value] of byOperation) {
        if (value.id === id) byOperation.set(operationId, { ...value, state: 'retired' })
      }
    },
  }
}

describe('provider contract harness', () => {
  it('adopts the instance after a lost create response', async () => {
    const driver = fakeDriver()
    await verifyLostResponseAdoption(driver, 'op_lost_response')
    expect((await driver.findByOperationId('op_lost_response'))?.id).toBe('instance-1')
  })

  it('normalizes the lifecycle', async () => {
    await verifyLifecycle(fakeDriver())
  })
})

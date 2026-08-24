import { expect } from 'vitest'

export interface ContractInstance {
  readonly id: string
  readonly operationId: string
  readonly state: 'running' | 'stopped' | 'retired'
}

export interface ProviderContractDriver {
  readonly create: (input: { readonly operationId: string }) => Promise<ContractInstance>
  readonly findByOperationId: (operationId: string) => Promise<ContractInstance | undefined>
  readonly stop: (id: string) => Promise<void>
  readonly start: (id: string) => Promise<void>
  readonly retire: (id: string) => Promise<void>
}

export const verifyLostResponseAdoption = async (
  driver: ProviderContractDriver,
  operationId: string,
): Promise<void> => {
  await driver.create({ operationId })
  const adopted = await driver.findByOperationId(operationId)
  expect(adopted?.operationId).toBe(operationId)
  const retried = adopted ?? (await driver.create({ operationId }))
  expect(retried.id).toBe(adopted?.id)
}

export const verifyLifecycle = async (driver: ProviderContractDriver): Promise<void> => {
  const instance = await driver.create({ operationId: 'op_contract_lifecycle' })
  await driver.stop(instance.id)
  await driver.start(instance.id)
  await driver.retire(instance.id)
  const found = await driver.findByOperationId(instance.operationId)
  expect(found?.state).toBe('retired')
}

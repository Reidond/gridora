import { describe, expect, it } from 'vitest'
import { validatePartition } from '../src/index.js'

describe('queue tenant partition', () => {
  it('accepts only organization-prefixed partition keys', () => {
    const event = {
      id: 'evt_1',
      organizationId: 'org_1',
      partitionKey: 'org_1:node_1',
      type: 'node.heartbeat',
      occurredAt: new Date().toISOString(),
      payload: {},
    }
    expect(validatePartition(event)).toBe(true)
    expect(validatePartition({ ...event, partitionKey: 'org_2:node_1' })).toBe(false)
  })
})

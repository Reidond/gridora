import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import {
  OrganizationId,
  organizationArtifactKey,
  organizationPartitionKey,
  roleAtLeast,
} from '../src/index.js'

describe('tenant-safe pure domain helpers', () => {
  it('always prefixes artifacts and partitions with the organization', () => {
    const id = Schema.decodeUnknownSync(OrganizationId)('org-a')
    expect(organizationArtifactKey(id, '/backups/one.tar.zst')).toBe(
      'organizations/org-a/backups/one.tar.zst',
    )
    expect(organizationPartitionKey(id, 'operation-1')).toBe('org-a:operation-1')
  })

  it('does not treat automation credentials as human organization administrators', () => {
    expect(roleAtLeast('automation', 'viewer')).toBe(false)
    expect(roleAtLeast('administrator', 'operator')).toBe(true)
  })
})

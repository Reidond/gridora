import { describe, expect, it } from 'vitest'
import { organizationObjectKey, redact } from '../src/index.js'

describe('observability', () => {
  it('redacts secret-shaped fields recursively', () => {
    expect(redact({ accessToken: 'secret', nested: { password: 'secret', safe: 'ok' } })).toEqual({
      accessToken: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'ok' },
    })
  })

  it('prefixes tenant-owned object keys', () => {
    expect(organizationObjectKey('org_1', 'logs', 'server/1')).toBe(
      'organizations/org_1/logs/server%2F1',
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  accessRedirectUrl,
  canManage,
  canOperate,
  safeAuthReturnPath,
  safeAppPath,
  summarizeFleet,
  toSlug,
} from './gridora'

describe('Gridora web domain helpers', () => {
  it('normalizes organization slugs', () =>
    expect(toSlug(' Night Watch — EU! ')).toBe('night-watch-eu'))
  it('applies role capabilities without granting viewers mutations', () => {
    expect(canManage('Owner')).toBe(true)
    expect(canManage('Operator')).toBe(false)
    expect(canOperate('Operator')).toBe(true)
    expect(canOperate('Viewer')).toBe(false)
  })
  it('summarizes genuine resource state', () => {
    const summary = summarizeFleet(
      [
        { status: 'running', health: 'healthy' },
        { status: 'stopped', health: 'degraded' },
      ] as never,
      [{ status: 'ready' }, { status: 'offline' }] as never,
      [{ status: 'running' }, { status: 'succeeded' }] as never,
    )
    expect(summary).toEqual({ running: 1, degraded: 1, readyNodes: 1, activeOperations: 1 })
  })
  it.each([
    '//attacker.example/path',
    '/%2f%2fattacker.example',
    '/%2F%2Fattacker.example',
    '/%5c%5cattacker.example',
    '/\\attacker.example',
    'https://attacker.example',
  ])('rejects unsafe authentication return target %s', (target) => {
    expect(safeAppPath(target)).toBe('/')
  })
  it('keeps a normal organization return target', () => {
    expect(safeAppPath('/o/night-watch/overview?tab=fleet#ready')).toBe(
      '/o/night-watch/overview?tab=fleet#ready',
    )
  })
  it('reduces arbitrary application paths to the authentication allowlist', () => {
    expect(safeAuthReturnPath('/o/night-watch/settings')).toBe('/')
    expect(safeAuthReturnPath('/invitations/opaque-token')).toBe('/invitations/opaque-token')
  })
  it('sends only opaque state to the identity provider', () => {
    const redirect = new URL(
      accessRedirectUrl(
        'https://access.example/cdn-cgi/access/login?legacy=1#fragment',
        'opaque_123',
      ),
    )
    expect([...redirect.searchParams.entries()]).toEqual([['state', 'opaque_123']])
    expect(redirect.hash).toBe('')
    expect(redirect.href).not.toContain('displayName')
    expect(redirect.href).not.toContain('invitation')
    expect(redirect.href).not.toContain('csrf')
  })
})

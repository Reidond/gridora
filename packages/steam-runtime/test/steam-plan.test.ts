import { describe, expect, it } from 'vitest'
import { createSteamAppPlan, createSteamInstallPlan } from '../src/index.js'

describe('createSteamInstallPlan', () => {
  it('creates an argv-only anonymous unprivileged plan', () => {
    const plan = createSteamInstallPlan({
      serverId: 'server-1',
      appId: 1874900,
      validate: true,
      credentialMode: 'anonymous',
    })
    expect(plan.argv).toContain('anonymous')
    expect(plan.argv).toContain('validate')
    expect(plan.uid).toBe(10001)
    expect(plan).not.toHaveProperty('shell')
  })
  it('keeps credentialed mode disabled', () => {
    expect(() =>
      createSteamInstallPlan({
        serverId: 'server-1',
        appId: 1,
        validate: false,
        credentialMode: 'credential-reference',
      }),
    ).toThrow(/not production-ready/)
  })
  it.each(['.', '..'])('rejects traversal-like server ID %s', (serverId) => {
    expect(() =>
      createSteamInstallPlan({
        serverId,
        appId: 1,
        validate: false,
        credentialMode: 'anonymous',
      }),
    ).toThrow(/path-safe/)
  })
  it('creates deterministic fixed argv for install and update', () => {
    const input = {
      installRoot: '/var/lib/gridora/servers/server-1/game',
      appId: 1874900,
      validate: true,
      operation: 'update' as const,
      credentialMode: 'anonymous' as const,
    }
    const first = createSteamAppPlan(input)
    expect(createSteamAppPlan(input)).toEqual(first)
    expect(first.executable).toBe('/usr/local/bin/steamcmd')
    expect(first.argv).toEqual([
      '+force_install_dir',
      '/var/lib/gridora/servers/server-1/game',
      '+login',
      'anonymous',
      '+app_update',
      '1874900',
      'validate',
      '+quit',
    ])
    expect(first).not.toHaveProperty('shell')
  })
  it.each([
    '/var/lib/gridora/servers/server-1/../escape',
    '/var/lib/gridora/servers/server-1/./game',
    '/var/lib/gridora/servers/server-1\0/game',
  ])('rejects unsafe install root %s', (installRoot) => {
    expect(() =>
      createSteamAppPlan({
        installRoot,
        appId: 1,
        validate: false,
        operation: 'install',
        credentialMode: 'anonymous',
      }),
    ).toThrow(/path-safe/)
  })
  it('rejects branch text that could become SteamCMD command input', () => {
    expect(() =>
      createSteamAppPlan({
        installRoot: '/var/lib/gridora/servers/server-1/game',
        appId: 1,
        validate: false,
        operation: 'update',
        branch: 'public +quit',
        credentialMode: 'anonymous',
      }),
    ).toThrow(/branch/)
  })
})

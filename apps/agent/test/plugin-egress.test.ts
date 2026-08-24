import { describe, expect, it } from 'vitest'
import { resolvePluginEgressEntries } from '../src/plugin-egress.js'

describe('plugin egress lease resolution', () => {
  it('turns only reviewed hostnames into bounded public destination tuples', async () => {
    const resolver = async (host: string) => [
      { address: host.startsWith('api.') ? '93.184.216.34' : '8.8.8.8', family: 4 as const },
    ]
    const entries = await resolvePluginEgressEntries(
      ['steamcommunity.com', 'api.steampowered.com', 'steamcommunity.com'],
      resolver,
    )
    expect(entries).toHaveLength(120)
    expect(entries).toContainEqual({ address: '8.8.8.8', protocol: 'tcp', port: 443 })
    expect(entries).toContainEqual({ address: '93.184.216.34', protocol: 'udp', port: 27_015 })
    expect(new Set(entries.map((entry) => JSON.stringify(entry))).size).toBe(entries.length)
  })

  it('fails closed for mixed private answers, IPv6-only answers, and wildcard permissions', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ]
    await expect(resolvePluginEgressEntries(['api.steampowered.com'], mixed)).rejects.toThrow(
      /private|reserved/,
    )
    const ipv6 = async () => [{ address: '2001:4860:4860::8888', family: 6 as const }]
    await expect(resolvePluginEgressEntries(['api.steampowered.com'], ipv6)).rejects.toThrow(/IPv4/)
    await expect(resolvePluginEgressEntries(['*.steamcontent.com'], mixed)).rejects.toThrow(
      /canonical hostname/,
    )
  })
})

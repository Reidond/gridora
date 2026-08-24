import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const helper = resolve(process.cwd(), 'infra/images/gridora-firewall-observation')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fakeNft = async (document: unknown) => {
  const root = await mkdtemp(join(tmpdir(), 'gridora-firewall-'))
  roots.push(root)
  const executable = join(root, 'nft')
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(document)}'\n`)
  await chmod(executable, 0o700)
  return executable
}

const ruleset = (tcp: readonly unknown[] = [2302, 2303], udp: readonly unknown[] = [2456]) => ({
  nftables: [
    { table: { family: 'inet', name: 'gridora' } },
    {
      set: {
        family: 'inet',
        name: 'leased_tcp_ports',
        table: 'gridora',
        type: 'inet_service',
        flags: ['interval'],
        elem: tcp,
      },
    },
    {
      set: {
        family: 'inet',
        name: 'leased_udp_ports',
        table: 'gridora',
        type: 'inet_service',
        flags: ['interval'],
        elem: udp,
      },
    },
    {
      set: {
        family: 'inet',
        name: 'permitted_game_egress_v4',
        table: 'gridora',
        type: ['ifname', 'ipv4_addr', 'inet_proto', 'inet_service'],
        flags: ['interval', 'timeout'],
        timeout: 3_900_000,
        'gc-interval': 30_000,
      },
    },
    {
      chain: {
        family: 'inet',
        table: 'gridora',
        name: 'input',
        type: 'filter',
        hook: 'input',
        prio: 0,
        policy: 'drop',
      },
    },
    {
      chain: {
        family: 'inet',
        table: 'gridora',
        name: 'forward',
        type: 'filter',
        hook: 'forward',
        prio: 0,
        policy: 'drop',
      },
    },
    {
      chain: {
        family: 'inet',
        table: 'gridora',
        name: 'output',
        type: 'filter',
        hook: 'output',
        prio: 0,
        policy: 'accept',
      },
    },
    rule('input', [match('in', { ct: { key: 'state' } }, 'invalid'), { drop: null }]),
    rule('input', [
      match('in', { ct: { key: 'state' } }, ['established', 'related']),
      { accept: null },
    ]),
    rule('input', [match('==', { meta: { key: 'iifname' } }, 'lo'), { accept: null }]),
    rule('input', [
      match('==', { payload: { protocol: 'ip', field: 'protocol' } }, 1),
      { accept: null },
    ]),
    rule('input', [
      match('==', { payload: { protocol: 'ip6', field: 'nexthdr' } }, 58),
      { accept: null },
    ]),
    rule('input', [
      match('==', { payload: { protocol: 'tcp', field: 'dport' } }, '@leased_tcp_ports'),
      { accept: null },
    ]),
    rule('input', [
      match('==', { payload: { protocol: 'udp', field: 'dport' } }, '@leased_udp_ports'),
      { accept: null },
    ]),
    rule('forward', [
      match('in', { ct: { key: 'state' } }, ['established', 'related']),
      { accept: null },
    ]),
    rule('forward', [
      match(
        '==',
        {
          concat: [
            { meta: { key: 'iifname' } },
            { payload: { protocol: 'ip', field: 'daddr' } },
            { meta: { key: 'l4proto' } },
            { payload: { protocol: 'th', field: 'dport' } },
          ],
        },
        '@permitted_game_egress_v4',
      ),
      { accept: null },
    ]),
    rule('forward', [
      match('==', { payload: { protocol: 'tcp', field: 'dport' } }, '@leased_tcp_ports'),
      { accept: null },
    ]),
    rule('forward', [
      match('==', { payload: { protocol: 'udp', field: 'dport' } }, '@leased_udp_ports'),
      { accept: null },
    ]),
  ],
})

function match(op: string, left: unknown, right: unknown) {
  return { match: { op, left, right } }
}

function rule(chain: string, expr: readonly unknown[]) {
  return { rule: { family: 'inet', table: 'gridora', chain, expr } }
}

describe('fixed firewall observation helper', () => {
  it('returns one bounded, sorted, exact response from the fixed table read', async () => {
    const nft = await fakeNft(ruleset([2303, 2302, 2302], [2457, 2456]))
    const { stdout } = await execute(helper, [], {
      env: { ...process.env, GRIDORA_TEST_NFT_COMMAND: nft },
    })
    const response = JSON.parse(stdout) as Record<string, unknown>

    expect(Object.keys(response).sort()).toEqual([
      'allowedTcpPorts',
      'allowedUdpPorts',
      'defaultDeny',
      'ready',
      'rulesetSha256',
      'schemaVersion',
    ])
    expect(response).toMatchObject({
      schemaVersion: 1,
      defaultDeny: true,
      allowedTcpPorts: [2302, 2303],
      allowedUdpPorts: [2456, 2457],
      ready: true,
    })
    expect(response.rulesetSha256).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16 * 1024)
  })

  it('closes without partial proof for malformed, missing, or unbounded leased sets', async () => {
    const cases = [
      ruleset([0], []),
      ruleset(
        Array.from({ length: 65 }, (_, index) => index + 1),
        [],
      ),
      { nftables: ruleset().nftables.filter((entry) => !('set' in entry)) },
    ]
    for (const document of cases) {
      const nft = await fakeNft(document)
      await expect(
        execute(helper, [], { env: { ...process.env, GRIDORA_TEST_NFT_COMMAND: nft } }),
      ).rejects.toMatchObject({ stdout: '' })
    }
  })

  it('rejects broad accepts and every extra rule, chain, hook, or set', async () => {
    const mutations = [
      (source: ReturnType<typeof ruleset>) => ({
        nftables: [...source.nftables, rule('input', [{ accept: null }])],
      }),
      (source: ReturnType<typeof ruleset>) => ({
        nftables: [
          ...source.nftables,
          {
            chain: {
              family: 'inet',
              table: 'gridora',
              name: 'bypass',
              type: 'filter',
              hook: 'input',
              prio: -1,
              policy: 'accept',
            },
          },
        ],
      }),
      (source: ReturnType<typeof ruleset>) => ({
        nftables: [
          ...source.nftables,
          {
            set: {
              family: 'inet',
              table: 'gridora',
              name: 'unexpected',
              type: 'inet_service',
              flags: ['interval'],
            },
          },
        ],
      }),
    ]
    for (const mutate of mutations) {
      const nft = await fakeNft(mutate(ruleset()))
      await expect(
        execute(helper, [], { env: { ...process.env, GRIDORA_TEST_NFT_COMMAND: nft } }),
      ).rejects.toMatchObject({ stdout: '' })
    }
  })
})

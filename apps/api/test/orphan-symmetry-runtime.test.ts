import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { type OrphanSymmetryObservedResource } from '@gridora/orphan-control'
import {
  discoverR2BackupPrefixes,
  makeOrphanSymmetryDiscovery,
  makeProductionOrphanSymmetrySources,
  projectAgentSymmetryInventory,
  projectDnsSymmetryRecord,
  projectTunnelSymmetryAuthority,
  type OrphanSymmetryReadSource,
} from '../src/orphan-symmetry-runtime.js'
import type { OrphanD1Database, OrphanD1Statement } from '@gridora/orphan-d1'

const request = {
  organizationId: 'org-a',
  actorId: 'scheduler-a',
  runId: 'symmetry-run-a',
  idempotencyKey: 'symmetry-idempotency-a',
}
const observed = (kind: OrphanSymmetryObservedResource['kind'], resourceKey: string) => ({
  organizationId: 'org-a',
  kind,
  resourceKey,
  resourceId: `${kind}-a`,
  nodeId: kind === 'backup-object' || kind === 'dns-record' ? null : 'node-a',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  ownerScope: 'tenant' as const,
  observedAt: '2026-08-24T10:00:00.000Z',
})

describe('orphan symmetry API/queue composition', () => {
  it('uses exact Cloudflare zone, owner comment, and account-scoped Tunnel reads', async () => {
    const paths: string[] = []
    class StubStatement implements OrphanD1Statement {
      constructor(readonly sql: string) {}
      bind(): OrphanD1Statement {
        return this
      }
      async first(): Promise<unknown> {
        return { id: 'org-a' }
      }
      async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
        if (this.sql.includes('FROM dns_records record'))
          return {
            results: [
              {
                serverId: 'server-a',
                hostname: 'server-a.example.test',
                target: '192.0.2.1',
                providerRecordId: 'record-a',
                recordType: 'A',
                zoneId: 'zone-a',
              },
            ],
          }
        if (this.sql.includes('FROM tunnels'))
          return {
            results: [{ nodeId: 'node-a', tunnelId: 'tunnel-a', hostname: 'node-a.example.test' }],
          }
        return { results: [] }
      }
    }
    const database: OrphanD1Database = {
      prepare: (sql) => new StubStatement(sql),
      batch: async () => [],
    }
    const sourceApi = {
      request: (input: { readonly path: string }) => {
        paths.push(input.path)
        return Effect.succeed(
          input.path.startsWith('/zones/')
            ? {
                result: [
                  {
                    id: 'record-a',
                    type: 'A',
                    name: 'server-a.example.test',
                    content: '192.0.2.1',
                    comment: 'gridora:org=org-a;owner=server-a',
                  },
                ],
              }
            : {
                result: [
                  {
                    id: 'tunnel-a',
                    name: 'gridora:org-a:node-a:Node tunnel',
                  },
                ],
              },
        )
      },
    }
    const sources = makeProductionOrphanSymmetrySources({
      database,
      dnsApi: sourceApi,
      tunnelApi: sourceApi,
      cloudflareAccountId: 'account-a',
      r2: { list: async () => ({ objects: [], truncated: false }) },
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    })
    const dns = sources[1]
    const tunnel = sources[2]
    if (dns === undefined || tunnel === undefined)
      throw new Error('production sources are incomplete')
    await expect(Effect.runPromise(dns.list(request, null))).resolves.toMatchObject({
      resources: [
        {
          kind: 'dns-record',
          resourceKey: 'server-a.example.test',
          resourceId: 'record-a',
          ownerScope: 'tenant',
        },
      ],
    })
    await expect(Effect.runPromise(tunnel.list(request, null))).resolves.toMatchObject({
      resources: [
        {
          kind: 'tunnel-authority',
          resourceKey: 'node-a',
          resourceId: 'tunnel-a',
          ownerScope: 'tenant',
        },
      ],
    })
    expect(paths).toEqual([
      '/zones/zone-a/dns_records?type=A&name.exact=server-a.example.test&match=all',
      '/accounts/account-a/cfd_tunnel?name=gridora%3Aorg-a%3Anode-a%3ANode%20tunnel&is_deleted=false',
    ])
    expect(Object.keys(sources[0] ?? {})).not.toContain('delete')
    expect(Object.keys(sources[3] ?? {})).not.toContain('delete')
  })

  it('projects Docker labels, ports, DNS, and Tunnel authority into stable safe coordinates', async () => {
    const [agent, dns, tunnel] = await Promise.all([
      Effect.runPromise(
        projectAgentSymmetryInventory(request, {
          organizationId: 'org-a',
          observedAt: '2026-08-24T10:00:00.000Z',
          containers: [
            {
              nodeId: 'node-a',
              containerId: 'container-a',
              deploymentId: 'deployment-a',
              serverId: 'server-a',
              desiredRevision: 3,
              ownerScope: 'tenant',
            },
          ],
          ports: [
            {
              nodeId: 'node-a',
              leaseId: 'lease-a',
              serverId: 'server-a',
              protocol: 'udp',
              publicPort: 2001,
              containerPort: 2001,
              operationId: 'operation-a',
              revision: 2,
              ownerScope: 'foreign',
            },
          ],
        }),
      ),
      Effect.runPromise(
        projectDnsSymmetryRecord(request, {
          providerRecordId: 'provider-record-a',
          hostname: 'server-a.example.test',
          target: '192.0.2.1',
          ownerScope: 'tenant',
          observedAt: '2026-08-24T10:00:00.000Z',
        }),
      ),
      Effect.runPromise(
        projectTunnelSymmetryAuthority(request, {
          nodeId: 'node-a',
          tunnelId: 'tunnel-a',
          hostname: 'node-a.example.test',
          ownerScope: 'tenant',
          observedAt: '2026-08-24T10:00:00.000Z',
        }),
      ),
    ])

    expect(agent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'deployment-container',
          resourceKey: 'node-a:server-a',
        }),
        expect.objectContaining({
          kind: 'port-lease',
          resourceKey: 'node-a:udp:2001',
          ownerScope: 'foreign',
        }),
      ]),
    )
    expect(dns).toMatchObject({ kind: 'dns-record', resourceKey: 'server-a.example.test' })
    expect(tunnel).toMatchObject({ kind: 'tunnel-authority', resourceKey: 'node-a' })
    expect(
      [...agent, dns, tunnel].every(({ fingerprint }) => /^sha256:[0-9a-f]{64}$/.test(fingerprint)),
    ).toBe(true)
  })

  it('walks fixed read-only sources through opaque bounded cursors', async () => {
    const calls: string[] = []
    const sources: ReadonlyArray<OrphanSymmetryReadSource> = [
      {
        name: 'agent',
        list: (_request, cursor) => {
          calls.push(`agent:${cursor ?? 'start'}`)
          return Effect.succeed(
            cursor === null
              ? {
                  resources: [observed('deployment-container', 'node-a:server-a')],
                  nextCursor: 'agent-2',
                }
              : { resources: [observed('port-lease', 'node-a:udp:2001')], nextCursor: null },
          )
        },
      },
      {
        name: 'dns',
        list: (_request, cursor) => {
          calls.push(`dns:${cursor ?? 'start'}`)
          return Effect.succeed({
            resources: [observed('dns-record', 'server-a.example.test')],
            nextCursor: null,
          })
        },
      },
      {
        name: 'tunnel',
        list: () => {
          calls.push('tunnel:start')
          return Effect.succeed({ resources: [], nextCursor: null })
        },
      },
      {
        name: 'r2',
        list: () => {
          calls.push('r2:start')
          return Effect.succeed({ resources: [], nextCursor: null })
        },
      },
    ]
    const discovery = makeOrphanSymmetryDiscovery(sources)
    const first = await Effect.runPromise(discovery.discoverPage(request, null))
    const second = await Effect.runPromise(discovery.discoverPage(request, first.nextCursor))
    const third = await Effect.runPromise(discovery.discoverPage(request, second.nextCursor))
    const fourth = await Effect.runPromise(discovery.discoverPage(request, third.nextCursor))
    const fifth = await Effect.runPromise(discovery.discoverPage(request, fourth.nextCursor))

    expect(calls).toEqual(['agent:start', 'agent:agent-2', 'dns:start', 'tunnel:start', 'r2:start'])
    expect(first).toMatchObject({ complete: false, nextCursor: 's0:agent-2' })
    expect(second).toMatchObject({ complete: false, nextCursor: 's1:start' })
    expect(third).toMatchObject({ complete: false, nextCursor: 's2:start' })
    expect(fourth).toMatchObject({ complete: false, nextCursor: 's3:start' })
    expect(fifth).toMatchObject({ complete: true, nextCursor: null })
  })

  it('groups a paginated manifest/chunk listing into exact tenant backup prefixes', async () => {
    const requests: Array<Record<string, unknown>> = []
    const result = await Effect.runPromise(
      discoverR2BackupPrefixes(
        {
          list: async (input) => {
            requests.push(input)
            if (input.cursor === undefined)
              return {
                objects: [
                  {
                    key: 'organizations/org-a/servers/server-a/backups/backup-a/chunks/00000000.bin',
                  },
                ],
                truncated: true,
                cursor: 'r2-page-2',
              }
            return {
              objects: [
                {
                  key: 'organizations/org-a/servers/server-a/backups/backup-a/manifest.json',
                },
                {
                  key: 'organizations/org-a/servers/server-a/backups/backup-b/chunks/00000000.bin',
                },
              ],
              truncated: false,
            }
          },
        },
        request,
        () => new Date('2026-08-24T10:00:00.000Z'),
      ),
    )

    expect(requests).toHaveLength(2)
    expect(requests.every(({ prefix }) => prefix === 'organizations/org-a/')).toBe(true)
    expect(result.resources).toHaveLength(2)
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKey: 'organizations/org-a/servers/server-a/backups/backup-a',
          resourceId: 'backup-a',
          ownerScope: 'tenant',
        }),
        expect.objectContaining({
          resourceKey: 'organizations/org-a/servers/server-a/backups/backup-b',
          resourceId: 'backup-b',
          ownerScope: 'tenant',
        }),
      ]),
    )
  })

  it('rejects a foreign R2 key and never receives a delete capability', async () => {
    await expect(
      Effect.runPromise(
        discoverR2BackupPrefixes(
          {
            list: async () => ({
              objects: [
                {
                  key: 'organizations/org-b/servers/server-b/backups/backup-b/manifest.json',
                },
              ],
              truncated: false,
            }),
          },
          request,
          () => new Date('2026-08-24T10:00:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })
})

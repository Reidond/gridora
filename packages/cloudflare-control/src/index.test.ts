import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { CloudflareControlError, makeCloudflareControl } from './index.js'
describe('Cloudflare control ownership', () => {
  const input = {
    organizationId: 'org',
    ownerResourceId: 'server',
    zoneId: 'z',
    name: 'g.example',
    type: 'A' as const,
    content: '192.0.2.1',
    proxied: false as const,
  }
  it('creates missing DNS records as DNS-only', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = []
    const control = makeCloudflareControl({
      request: (r) => {
        requests.push(r)
        return Effect.succeed(r.method === 'GET' ? { result: [] } : { result: { id: 'new' } })
      },
    })
    await Effect.runPromise(control.upsertDnsRecord(input))
    expect(requests[1]).toMatchObject({
      method: 'POST',
      path: '/zones/z/dns_records',
      body: { proxied: false, comment: 'gridora:org=org;owner=server' },
    })
  })
  it('adopts and updates an exactly owned record by returned ID', async () => {
    const requests: { method: string; path: string }[] = []
    const control = makeCloudflareControl({
      request: (r) => {
        requests.push(r)
        return Effect.succeed(
          r.method === 'GET'
            ? {
                result: [
                  {
                    id: 'real-id',
                    type: 'A',
                    name: 'g.example',
                    content: '192.0.2.2',
                    comment: 'gridora:org=org;owner=server',
                  },
                ],
              }
            : { result: {} },
        )
      },
    })
    await Effect.runPromise(control.upsertDnsRecord(input))
    expect(requests[1]).toMatchObject({ method: 'PUT', path: '/zones/z/dns_records/real-id' })
  })
  it('refuses to update or delete a foreign exact record', async () => {
    const requests: { method: string }[] = []
    const control = makeCloudflareControl({
      request: (r) => {
        requests.push(r)
        return Effect.succeed({
          result: [
            {
              id: 'foreign',
              type: 'A',
              name: 'g.example',
              content: '192.0.2.2',
              comment: 'human managed',
            },
          ],
        })
      },
    })
    const result = await Effect.runPromise(Effect.result(control.upsertDnsRecord(input)))
    expect(result._tag).toBe('Failure')
    expect(requests).toHaveLength(1)
  })
  it('fails closed when an immutable DNS delete receipt points to another zone or record id', async () => {
    const absentRequests: string[] = []
    const absent = makeCloudflareControl({
      request: (request) => {
        absentRequests.push(request.method)
        return Effect.succeed({ result: [] })
      },
    })
    await expect(
      Effect.runPromise(
        absent.deleteDnsRecord({
          organizationId: 'org',
          ownerResourceId: 'server',
          zoneId: 'wrong-zone',
          name: 'g.example',
          type: 'A',
          expectedRecordId: 'published-record',
          expectedContent: '192.0.2.1',
        }),
      ),
    ).rejects.toMatchObject({ operation: 'deleteDnsRecord' })
    expect(absentRequests).toEqual(['GET'])

    const mismatchedRequests: string[] = []
    const mismatched = makeCloudflareControl({
      request: (request) => {
        mismatchedRequests.push(request.method)
        return Effect.succeed({
          result: [
            {
              id: 'other-record',
              type: 'A',
              name: 'g.example',
              content: '192.0.2.1',
              comment: 'gridora:org=org;owner=server',
            },
          ],
        })
      },
    })
    await expect(
      Effect.runPromise(
        mismatched.deleteDnsRecord({
          organizationId: 'org',
          ownerResourceId: 'server',
          zoneId: 'published-zone',
          name: 'g.example',
          type: 'A',
          expectedRecordId: 'published-record',
          expectedContent: '192.0.2.1',
        }),
      ),
    ).rejects.toMatchObject({ operation: 'deleteDnsRecord' })
    expect(mismatchedRequests).toEqual(['GET'])
  })
  it('transfers only an exact source-owned DNS record and adopts the exact next state', async () => {
    const requests: { method: string; body?: unknown }[] = []
    let transferred = false
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request)
        if (request.method === 'PUT') {
          transferred = true
          return Effect.succeed({ result: { id: 'record-a' } })
        }
        return Effect.succeed({
          result: [
            {
              id: 'record-a',
              type: 'A',
              name: 'g.example',
              content: transferred ? '192.0.2.20' : '192.0.2.10',
              comment: transferred
                ? 'gridora:org=org;owner=target-server'
                : 'gridora:org=org;owner=source-server',
            },
          ],
        })
      },
    })
    const transfer = {
      organizationId: 'org',
      zoneId: 'z',
      name: 'g.example',
      type: 'A' as const,
      expectedOwnerResourceId: 'source-server',
      expectedContent: '192.0.2.10',
      nextOwnerResourceId: 'target-server',
      nextContent: '192.0.2.20',
    }
    await expect(Effect.runPromise(control.transferDnsRecord(transfer))).resolves.toEqual({
      recordId: 'record-a',
      disposition: 'applied',
    })
    await expect(Effect.runPromise(control.transferDnsRecord(transfer))).resolves.toEqual({
      recordId: 'record-a',
      disposition: 'adopted',
    })
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET'])
  })
  it('rejects a foreign, stale, or mixed DNS transfer state without PUT', async () => {
    const requests: string[] = []
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request.method)
        return Effect.succeed({
          result: [
            {
              id: 'record-a',
              type: 'A',
              name: 'g.example',
              content: '192.0.2.99',
              comment: 'gridora:org=org;owner=foreign-server',
            },
          ],
        })
      },
    })
    const result = await Effect.runPromise(
      Effect.result(
        control.transferDnsRecord({
          organizationId: 'org',
          zoneId: 'z',
          name: 'g.example',
          type: 'A',
          expectedOwnerResourceId: 'source-server',
          expectedContent: '192.0.2.10',
          nextOwnerResourceId: 'target-server',
          nextContent: '192.0.2.20',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(requests).toEqual(['GET'])
  })
  it('adopts the exact next record after a lost PUT response', async () => {
    const requests: string[] = []
    let transferred = false
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request.method)
        if (request.method === 'PUT') {
          transferred = true
          return Effect.fail(
            new CloudflareControlError({
              operation: 'test.put',
              message: 'response lost',
              retryable: true,
            }),
          )
        }
        return Effect.succeed({
          result: [
            {
              id: 'record-a',
              type: 'A',
              name: 'g.example',
              content: transferred ? '192.0.2.20' : '192.0.2.10',
              comment: transferred
                ? 'gridora:org=org;owner=target-server'
                : 'gridora:org=org;owner=source-server',
            },
          ],
        })
      },
    })
    await expect(
      Effect.runPromise(
        control.transferDnsRecord({
          organizationId: 'org',
          zoneId: 'z',
          name: 'g.example',
          type: 'A',
          expectedOwnerResourceId: 'source-server',
          expectedContent: '192.0.2.10',
          nextOwnerResourceId: 'target-server',
          nextContent: '192.0.2.20',
        }),
      ),
    ).resolves.toEqual({ recordId: 'record-a', disposition: 'adopted' })
    expect(requests).toEqual(['GET', 'PUT', 'GET'])
  })
  it('lets Cloudflare generate the Access audience', async () => {
    let body: unknown
    const control = makeCloudflareControl({
      request: (r) => {
        if (r.method === 'POST') body = r.body
        return Effect.succeed(r.method === 'GET' ? { result: [] } : { result: {} })
      },
    })
    await Effect.runPromise(
      control.createAccessApplication({
        organizationId: 'org',
        ownerResourceId: 'node',
        accountId: 'a',
        name: 'Node',
        domain: 'node.example',
      }),
    )
    expect(body).toEqual({
      type: 'self_hosted',
      name: 'gridora:org:node:Node',
      domain: 'node.example',
    })
    expect(body).not.toHaveProperty('aud')
  })
  it('deletes only a tunnel with the exact Gridora ownership name', async () => {
    const requests: { method: string }[] = []
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request)
        return Effect.succeed(
          request.method === 'GET'
            ? { result: { id: 'tunnel-id', name: 'gridora:org:node:Node tunnel' } }
            : { result: { id: 'tunnel-id' } },
        )
      },
    })
    await Effect.runPromise(
      control.deleteTunnel({
        organizationId: 'org',
        ownerResourceId: 'node',
        accountId: 'account',
        name: 'Node tunnel',
        tunnelId: 'tunnel-id',
      }),
    )
    expect(requests.map((request) => request.method)).toEqual(['GET', 'DELETE'])
  })
  it('fails closed without deleting a foreign or missing tunnel', async () => {
    const requests: { method: string }[] = []
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request)
        return Effect.succeed({ result: { id: 'tunnel-id', name: 'human-managed' } })
      },
    })
    const result = await Effect.runPromise(
      Effect.result(
        control.deleteTunnel({
          organizationId: 'org',
          ownerResourceId: 'node',
          accountId: 'account',
          name: 'Node tunnel',
          tunnelId: 'tunnel-id',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(requests).toHaveLength(1)
  })
  it('adopts an exactly owned tunnel without a second create', async () => {
    const requests: { method: string }[] = []
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request)
        return Effect.succeed({
          result: [{ id: 'tunnel-id', name: 'gridora:org:node:Node tunnel' }],
        })
      },
    })
    const result = await Effect.runPromise(
      control.createTunnel({
        organizationId: 'org',
        ownerResourceId: 'node',
        accountId: 'account',
        name: 'Node tunnel',
      }),
    )
    expect(result).toMatchObject({ adopted: true })
    expect(requests.map((request) => request.method)).toEqual(['GET'])
  })
  it('fails closed on ambiguous tunnels', async () => {
    const control = makeCloudflareControl({
      request: () =>
        Effect.succeed({
          result: [
            { id: 'one', name: 'gridora:org:node:Node tunnel' },
            { id: 'two', name: 'gridora:org:node:Node tunnel' },
          ],
        }),
    })
    const result = await Effect.runPromise(
      Effect.result(
        control.createTunnel({
          organizationId: 'org',
          ownerResourceId: 'node',
          accountId: 'account',
          name: 'Node tunnel',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
  })
  it('adopts only an exact owned self-hosted Access application', async () => {
    const requests: { method: string }[] = []
    const control = makeCloudflareControl({
      request: (request) => {
        requests.push(request)
        return Effect.succeed({
          result: [
            {
              id: 'app',
              name: 'gridora:org:node:Node',
              domain: 'node.example',
              type: 'self_hosted',
            },
          ],
        })
      },
    })
    const result = await Effect.runPromise(
      control.createAccessApplication({
        organizationId: 'org',
        ownerResourceId: 'node',
        accountId: 'account',
        name: 'Node',
        domain: 'node.example',
      }),
    )
    expect(result).toMatchObject({ adopted: true })
    expect(requests).toHaveLength(1)
  })
  it('refuses a foreign Access application on the requested domain', async () => {
    const control = makeCloudflareControl({
      request: () =>
        Effect.succeed({
          result: [
            { id: 'foreign', name: 'Human app', domain: 'node.example', type: 'self_hosted' },
          ],
        }),
    })
    const result = await Effect.runPromise(
      Effect.result(
        control.createAccessApplication({
          organizationId: 'org',
          ownerResourceId: 'node',
          accountId: 'account',
          name: 'Node',
          domain: 'node.example',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
  })
})

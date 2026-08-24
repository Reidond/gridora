import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { tunnelResourceName } from '@gridora/cloudflare-control'
import { makeNodeTerminationTunnelAdapter } from '../src/node-termination-tunnel-runtime.js'

const accountId = '0123456789abcdef0123456789abcdef'
const target = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  tunnelId: 'tunnel-a',
} as const

const ownedBody = () => ({
  result: {
    id: target.tunnelId,
    name: tunnelResourceName({
      accountId,
      organizationId: target.organizationId,
      ownerResourceId: target.nodeId,
      name: 'Node tunnel',
    }),
    config_src: 'cloudflare',
  },
})

const response = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('node retirement Tunnel adapter', () => {
  it('adopts a lost DELETE response only after one exact 404 reread', async () => {
    const methods: string[] = []
    const adapter = makeNodeTerminationTunnelAdapter({
      accountId,
      apiToken: { get: async () => 't'.repeat(32) },
      fetch: async (_url, init) => {
        const method = init?.method ?? 'GET'
        methods.push(method)
        if (method === 'GET' && methods.length === 1) return response(200, ownedBody())
        if (method === 'DELETE') throw new Error('lost response')
        return response(404, { result: null })
      },
    })

    await expect(Effect.runPromise(adapter.deleteExact(target))).resolves.toEqual({
      disposition: 'adopted',
    })
    expect(methods).toEqual(['GET', 'DELETE', 'GET'])
  })

  it('rejects a foreign tunnel before issuing DELETE', async () => {
    const methods: string[] = []
    const adapter = makeNodeTerminationTunnelAdapter({
      accountId,
      apiToken: { get: async () => 't'.repeat(32) },
      fetch: async (_url, init) => {
        methods.push(init?.method ?? 'GET')
        return response(200, {
          result: { id: target.tunnelId, name: 'foreign-tunnel', config_src: 'cloudflare' },
        })
      },
    })

    await expect(Effect.runPromise(adapter.deleteExact(target))).rejects.toMatchObject({
      code: 'node_tunnel_ownership_mismatch',
    })
    expect(methods).toEqual(['GET'])
  })

  it('does not claim a failed delete was absent when the owned Tunnel still exists', async () => {
    const methods: string[] = []
    const adapter = makeNodeTerminationTunnelAdapter({
      accountId,
      apiToken: { get: async () => 't'.repeat(32) },
      fetch: async (_url, init) => {
        const method = init?.method ?? 'GET'
        methods.push(method)
        if (method === 'DELETE') return response(503, { errors: [{ code: 1 }] })
        return response(200, ownedBody())
      },
    })

    await expect(Effect.runPromise(adapter.deleteExact(target))).rejects.toMatchObject({
      code: 'node_tunnel_delete_failed',
    })
    expect(methods).toEqual(['GET', 'DELETE', 'GET'])
  })
})

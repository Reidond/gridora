/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('exported API in the Workers runtime', () => {
  it('serves the generated contract from the real Worker export', async () => {
    const response = await SELF.fetch('https://gridora.test/openapi.json', {
      headers: { origin: 'https://console.gridora.example' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const document = (await response.json()) as {
      readonly openapi: string
      readonly paths: Readonly<Record<string, unknown>>
    }
    expect(document.openapi).toBe('3.1.0')
    expect(document.paths).toHaveProperty('/v1/organizations/{organization}/policy')
    expect(document.paths).toHaveProperty(
      '/v1/organizations/{organization}/nodes/{nodeId}/tunnels/{tunnelId}/credential-deliveries',
    )
    expect(document.paths).toHaveProperty('/v1/organizations/{organization}/backups/{id}')
  })

  it('returns the real non-disclosing problem boundary for an unknown route', async () => {
    const response = await SELF.fetch('https://gridora.test/no-such-route')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    await expect(response.json()).resolves.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    })
  })
})

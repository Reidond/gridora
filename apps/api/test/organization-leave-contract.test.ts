import { describe, expect, it } from 'vitest'
import { openApiDocument, unsupportedApiRoutes } from '../src/contracts.js'

describe('organization self-leave contract', () => {
  it('publishes the revision-fenced action and does not advertise it as unsupported', () => {
    const path = '/v1/organizations/{organization}/actions/leave'
    const operation = (openApiDocument.paths[path] as Record<string, unknown> | undefined)?.post
    expect(operation).toMatchObject({
      operationId: 'leaveOrganization',
      responses: { '200': { description: 'Success' } },
    })
    expect(
      unsupportedApiRoutes.some((route) => route.method === 'post' && route.path === path),
    ).toBe(false)
  })
})

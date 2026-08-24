import { describe, expect, it } from 'vitest'
import { openApiDocument, unsupportedApiRoutes } from '../src/contracts.js'

type OpenApiOperation = {
  readonly operationId: string
  readonly parameters: readonly {
    readonly in: string
    readonly name: string | undefined
    readonly required: boolean
  }[]
  readonly requestBody?: {
    readonly content: {
      readonly 'application/json': {
        readonly schema: {
          readonly properties?: Readonly<Record<string, unknown>>
          readonly required?: readonly string[]
        }
      }
    }
  }
  readonly responses: Readonly<Record<string, { readonly description: string }>>
}

const operation = (path: string, method: string): OpenApiOperation => {
  const paths = openApiDocument.paths as Readonly<
    Record<string, Readonly<Record<string, OpenApiOperation>>>
  >
  const match = paths[path]?.[method]
  if (match === undefined) throw new Error(`Missing ${method.toUpperCase()} ${path}`)
  return match
}

describe('game desired-state public contracts', () => {
  it('publishes the three read-only preview operations with strict bodies and path parameters', () => {
    const config = operation('/v1/organizations/{organization}/game-servers/{id}/config', 'get')
    const configPlan = operation(
      '/v1/organizations/{organization}/game-servers/{id}/config/plan',
      'post',
    )
    const modsPlan = operation(
      '/v1/organizations/{organization}/game-servers/{id}/mods/plan',
      'post',
    )

    expect(config).toMatchObject({
      operationId: 'getGameConfig',
      responses: { '200': { description: 'Success' } },
    })
    expect(configPlan).toMatchObject({
      operationId: 'previewGameConfig',
      responses: { '200': { description: 'Success' } },
    })
    expect(modsPlan).toMatchObject({
      operationId: 'planMods',
      responses: { '200': { description: 'Success' } },
    })
    for (const preview of [config, configPlan, modsPlan]) {
      expect(preview.parameters.map(({ in: location, name }) => `${location}:${name}`)).toEqual([
        'path:organization',
        'path:id',
      ])
      expect(preview.parameters.some(({ name }) => name === 'Idempotency-Key')).toBe(false)
    }
    expect(configPlan.requestBody?.content['application/json'].schema).toMatchObject({
      properties: {
        schemaVersion: {},
        expectedConfigRevision: {},
        config: {},
      },
      required: ['schemaVersion', 'expectedConfigRevision', 'config'],
    })
    expect(modsPlan.requestBody?.content['application/json'].schema).toMatchObject({
      properties: {
        schemaVersion: {},
        expectedConfigRevision: {},
        expectedModRevision: {},
        desiredMods: {},
      },
      required: ['schemaVersion', 'expectedConfigRevision', 'expectedModRevision', 'desiredMods'],
    })
  })

  it('publishes config and mod reads/plans plus accepted mutations', () => {
    const unsupported = new Set(
      unsupportedApiRoutes.map((route) => `${route.method} ${route.path}`),
    )
    expect(unsupported.has('get /v1/organizations/{organization}/game-servers/{id}/config')).toBe(
      false,
    )
    expect(
      unsupported.has('post /v1/organizations/{organization}/game-servers/{id}/config/plan'),
    ).toBe(false)
    expect(
      unsupported.has('post /v1/organizations/{organization}/game-servers/{id}/mods/plan'),
    ).toBe(false)
    expect(
      operation('/v1/organizations/{organization}/game-servers/{id}/config', 'post'),
    ).toMatchObject({
      operationId: 'applyGameConfig',
      responses: { '202': { description: 'Success' } },
    })
    expect(unsupported).not.toContain('get /v1/organizations/{organization}/game-servers/{id}/mods')
    expect(
      operation('/v1/organizations/{organization}/game-servers/{id}/mods', 'get'),
    ).toMatchObject({
      operationId: 'getGameMods',
      responses: { '200': { description: 'Success' } },
    })
    expect(
      operation('/v1/organizations/{organization}/game-servers/{id}/mods', 'put'),
    ).toMatchObject({
      operationId: 'syncMods',
      responses: { '202': { description: 'Success' } },
    })
    expect(operation('/v1/organizations/{organization}/game-servers/{id}', 'patch')).toMatchObject({
      operationId: 'patchGameServer',
      responses: { '202': { description: 'Success' } },
    })
  })
})

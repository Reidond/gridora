import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import {
  AgentRegistrationExchangeResponse,
  openApiDocument,
  unsupportedApiRoutes,
} from '../src/contracts.js'

type OpenApiOperation = {
  readonly operationId: string
  readonly parameters: readonly {
    readonly in: string
    readonly name: string
    readonly required: boolean
  }[]
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[]
  readonly requestBody?: {
    readonly content: {
      readonly 'application/json': {
        readonly schema: { readonly required?: readonly string[] }
      }
    }
  }
  readonly responses: Readonly<Record<string, { readonly description: string }>>
}

const operation = (path: string, method: string): OpenApiOperation => {
  const paths = openApiDocument.paths as Readonly<
    Record<string, Readonly<Record<string, OpenApiOperation>>>
  >
  const value = paths[path]?.[method]
  if (value === undefined) throw new Error(`Missing ${method.toUpperCase()} ${path}`)
  return value
}

describe('agent observation and organization realtime contracts', () => {
  it('does not advertise internal or machine implementation endpoints as public 501 operations', () => {
    const paths = openApiDocument.paths as Readonly<Record<string, unknown>>
    for (const path of [
      '/v1/agent/registration',
      '/v1/internal/workflow-steps/execute',
      '/v1/internal/queue-events',
    ]) {
      expect(paths[path]).toBeUndefined()
      expect(unsupportedApiRoutes.some((route) => route.path === path)).toBe(false)
    }
  })

  it('publishes strict machine-bearer observation ingestion without idempotency', () => {
    const accept = operation('/v1/agent/events', 'post')
    expect(accept).toMatchObject({
      operationId: 'acceptAgentEvents',
      security: [{ agentBearer: [] }],
      responses: { '200': { description: 'Success' } },
    })
    expect(accept.parameters.some(({ name }) => name === 'Idempotency-Key')).toBe(false)
    expect(accept.requestBody?.content['application/json'].schema.required).toEqual([
      'apiVersion',
      'organizationId',
      'nodeId',
      'sessionVersion',
      'sequence',
      'observedRevision',
      'issuedAt',
      'facts',
    ])
    expect(
      unsupportedApiRoutes.some(
        ({ method, path }) => method === 'post' && path === '/v1/agent/events',
      ),
    ).toBe(false)
  })

  it('publishes composed telemetry, health, archive, and exact-server live-log operations', () => {
    const telemetry = operation('/v1/agent/telemetry', 'post')
    const nodeHealth = operation('/v1/organizations/{organization}/nodes/{nodeId}/health', 'get')
    const serverHealth = operation(
      '/v1/organizations/{organization}/game-servers/{serverId}/health',
      'get',
    )
    const archives = operation(
      '/v1/organizations/{organization}/game-servers/{serverId}/logs',
      'get',
    )
    const ticket = operation(
      '/v1/organizations/{organization}/game-servers/{serverId}/logs/stream/ticket',
      'post',
    )
    const stream = operation(
      '/v1/organizations/{organization}/game-servers/{serverId}/logs/stream',
      'get',
    )
    const archive = operation(
      '/v1/organizations/{organization}/game-servers/{serverId}/logs/{archiveId}',
      'get',
    )

    expect(telemetry).toMatchObject({
      operationId: 'acceptAgentTelemetry',
      security: [{ agentBearer: [] }],
      responses: { '200': { description: 'Success' } },
    })
    expect(nodeHealth.operationId).toBe('getNodeHealth')
    expect(serverHealth.operationId).toBe('getGameServerHealth')
    expect(archives.operationId).toBe('listLogArchives')
    expect(ticket.operationId).toBe('issueLiveLogTicket')
    expect(stream).toMatchObject({
      operationId: 'streamLiveLogs',
      responses: { '101': { description: 'Switching Protocols' } },
    })
    expect(archive.operationId).toBe('getLogArchive')
    for (const [method, path] of [
      ['post', '/v1/agent/telemetry'],
      ['get', '/v1/organizations/{organization}/nodes/{nodeId}/health'],
      ['get', '/v1/organizations/{organization}/game-servers/{serverId}/health'],
      ['get', '/v1/organizations/{organization}/game-servers/{serverId}/logs'],
      ['post', '/v1/organizations/{organization}/game-servers/{serverId}/logs/stream/ticket'],
      ['get', '/v1/organizations/{organization}/game-servers/{serverId}/logs/stream'],
      ['get', '/v1/organizations/{organization}/game-servers/{serverId}/logs/{archiveId}'],
    ] as const)
      expect(
        unsupportedApiRoutes.some((route) => route.method === method && route.path === path),
      ).toBe(false)
  })

  it('exports observation metadata from registration exchange', () => {
    const decoded = Schema.decodeUnknownSync(AgentRegistrationExchangeResponse)({
      nodeCredential: 'n'.repeat(64),
      credentialId: 'credential-1',
      credentialVersion: 2,
      sessionVersion: 3,
      registrationTokenConsumed: true,
    })
    expect(decoded).toMatchObject({ credentialVersion: 2, sessionVersion: 3 })
    expect(() =>
      Schema.decodeUnknownSync(AgentRegistrationExchangeResponse)({
        nodeCredential: 'n'.repeat(64),
        credentialId: 'credential-1',
        credentialVersion: 0,
        sessionVersion: 3,
        registrationTokenConsumed: true,
      }),
    ).toThrow()
  })

  it('publishes ticket issuance and a ticket-bound WebSocket upgrade', () => {
    const issue = operation('/v1/organizations/{organization}/events/ticket', 'post')
    const stream = operation('/v1/organizations/{organization}/events', 'get')
    expect(issue).toMatchObject({
      operationId: 'issueOrganizationEventsTicket',
      responses: { '200': { description: 'Success' } },
    })
    expect(issue.parameters).toEqual([
      { in: 'path', name: 'organization', required: true, schema: { type: 'string' } },
    ])
    expect(stream).toMatchObject({
      operationId: 'streamOrganizationEvents',
      responses: { '101': { description: 'Switching Protocols' } },
    })
    expect(
      stream.parameters.map(({ in: location, name, required }) => ({
        location,
        name,
        required,
      })),
    ).toEqual([
      { location: 'path', name: 'organization', required: true },
      { location: 'query', name: 'ticket', required: true },
    ])
    expect(
      unsupportedApiRoutes.some(
        ({ method, path }) =>
          method === 'get' && path === '/v1/organizations/{organization}/events',
      ),
    ).toBe(false)
  })
})

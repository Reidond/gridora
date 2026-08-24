import { Effect } from 'effect'
import {
  ProviderTransportError,
  type CreateNodeInput,
  type JsonHttpClientShape,
  type ProviderNode,
} from '@gridora/provider-sdk'
import type { ContaboApi, ContaboApiError } from './index.js'

export interface ContaboHttpOptions {
  readonly contractPeriodMonths: 1 | 12 | 24
  readonly requestId: () => string
  readonly cancellation: (providerNodeId: string) => {
    readonly cancellationDate: string
    readonly billingStopsAt: string
  }
  readonly secureWipeAndStop: (
    providerNodeId: string,
  ) => Effect.Effect<{ readonly cancellationDate?: string }, ContaboApiError>
  readonly firewallIdForInstance: (providerNodeId: string) => string
  readonly firewallOwnershipDescription: (providerNodeId: string) => string
}
export interface ContaboOAuthOptions {
  readonly tokenUrl: string
  readonly apiBaseUrl: string
  readonly clientId: string
  readonly clientSecret: string
  readonly apiUser: string
  readonly apiPassword: string
}
const error = (message: string, status?: number): ContaboApiError => ({
  message,
  ...(status === undefined ? {} : { status }),
})
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined
const text = (value: unknown, key: string): string | undefined => {
  const result = field(value, key)
  return typeof result === 'string'
    ? result
    : typeof result === 'number'
      ? String(result)
      : undefined
}
const number = (value: unknown, key: string): number | undefined => {
  const result = field(value, key)
  return typeof result === 'number' ? result : undefined
}
const request = (
  http: JsonHttpClientShape,
  requestId: () => string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) =>
  Effect.flatMap(
    http.request({
      method,
      path,
      headers: { 'x-request-id': requestId() },
      ...(body === undefined ? {} : { body }),
    }),
    (response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(error(`Contabo API returned HTTP ${response.status}`, response.status)),
  )
const data = (body: unknown): Effect.Effect<readonly unknown[], ContaboApiError> => {
  const result = field(body, 'data')
  return Array.isArray(result)
    ? Effect.succeed(result)
    : Effect.fail(error('Contabo response is missing data'))
}
const totalPages = (body: unknown): number => number(field(body, '_pagination'), 'totalPages') ?? 1
const paginatedData = (
  http: JsonHttpClientShape,
  requestId: () => string,
  path: string,
): Effect.Effect<readonly unknown[], ContaboApiError> => {
  const load = (
    page: number,
    accumulated: readonly unknown[],
  ): Effect.Effect<readonly unknown[], ContaboApiError> =>
    Effect.flatMap(
      request(
        http,
        requestId,
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}page=${page}&size=1000`,
      ),
      (response) =>
        Effect.flatMap(data(response.body), (items) =>
          page >= totalPages(response.body)
            ? Effect.succeed([...accumulated, ...items])
            : load(page + 1, [...accumulated, ...items]),
        ),
    )
  return load(1, [])
}
/** Concrete Contabo password-grant client. Credentials stay inside the closure and are never included in errors. */
export const makeContaboOAuthHttpClient = (
  options: ContaboOAuthOptions,
): Effect.Effect<JsonHttpClientShape, never> =>
  Effect.sync(() => {
    let cached: { readonly token: string; readonly expiresAt: number } | undefined
    const token = (): Effect.Effect<string, ProviderTransportError> =>
      cached !== undefined && cached.expiresAt > Date.now() + 30_000
        ? Effect.succeed(cached.token)
        : Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(options.tokenUrl, {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                  accept: 'application/json',
                },
                body: new URLSearchParams({
                  grant_type: 'password',
                  client_id: options.clientId,
                  client_secret: options.clientSecret,
                  username: options.apiUser,
                  password: options.apiPassword,
                }),
                signal,
              })
              const body: unknown = await response.json()
              const accessToken = text(body, 'access_token')
              const expiresIn = number(body, 'expires_in')
              if (!response.ok || accessToken === undefined || expiresIn === undefined)
                throw new Error(`token endpoint returned HTTP ${response.status}`)
              cached = { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 }
              return accessToken
            },
            catch: (cause) =>
              new ProviderTransportError({
                message: cause instanceof Error ? cause.message : 'Contabo authentication failed',
                retryable: true,
              }),
          })
    return {
      request: (input) =>
        Effect.flatMap(token(), (accessToken) =>
          Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(new URL(input.path, options.apiBaseUrl), {
                method: input.method,
                headers: {
                  authorization: `Bearer ${accessToken}`,
                  accept: 'application/json',
                  ...input.headers,
                  ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
                signal,
              })
              const responseText = await response.text()
              let responseBody: unknown = undefined
              if (responseText.length > 0) {
                try {
                  responseBody = JSON.parse(responseText)
                } catch {
                  responseBody = responseText
                }
              }
              return {
                status: response.status,
                body: responseBody,
                headers: Object.fromEntries(response.headers.entries()),
              }
            },
            catch: (cause) =>
              new ProviderTransportError({
                message: cause instanceof Error ? cause.message : 'Contabo transport failed',
                retryable: true,
              }),
          }),
        ),
    }
  })
const encodeMetadataName = (input: CreateNodeInput): Effect.Effect<string, ContaboApiError> => {
  const value = [
    'gridora',
    input.organizationId,
    input.nodeId,
    input.operationId,
    input.imageVersion,
    input.name,
  ]
    .map(encodeURIComponent)
    .join('|')
  return value.length <= 255
    ? Effect.succeed(value)
    : Effect.fail(error('Gridora metadata displayName exceeds Contabo 255 character limit', 422))
}
const decodeNode = (item: unknown): Effect.Effect<ProviderNode, ContaboApiError> => {
  const id = text(item, 'instanceId')
  const encoded = text(item, 'displayName')
  const regionId = text(item, 'region')
  const planId = text(item, 'productId')
  const status = text(item, 'status')?.toLowerCase()
  if (id === undefined || encoded === undefined || regionId === undefined || planId === undefined)
    return Effect.fail(error('invalid Contabo instance response'))
  const parts = encoded.split('|').map((part) => decodeURIComponent(part))
  if (parts.length !== 6 || parts[0] !== 'gridora')
    return Effect.fail(error('Contabo instance lacks Gridora ownership metadata'))
  const organizationId = parts[1]!
  const nodeId = parts[2]!
  const operationId = parts[3]!
  const imageVersion = parts[4]!
  const name = parts[5]!
  const addresses: string[] = []
  const ipConfig = field(item, 'ipConfig')
  for (const version of ['v4', 'v6']) {
    const address = text(field(ipConfig, version), 'ip')
    if (address !== undefined) addresses.push(address)
  }
  const state: ProviderNode['state'] =
    status === 'running'
      ? 'active'
      : status === 'stopped'
        ? 'stopped'
        : status === 'provisioning'
          ? 'creating'
          : 'unknown'
  const periodEndsAt =
    text(item, 'cancelDate') ?? text(item, 'contractEndDate') ?? text(item, 'nextBillingDate')
  return Effect.succeed({
    id,
    name,
    state,
    regionId,
    planId,
    addresses,
    metadata: { managedBy: 'gridora', organizationId, nodeId, operationId, imageVersion },
    ...(periodEndsAt === undefined
      ? {}
      : {
          contract: {
            periodEndsAt,
            ...(text(item, 'cancelDate') === undefined
              ? {}
              : { cancellationDate: text(item, 'cancelDate')! }),
          },
        }),
  })
}
const first = <A>(items: readonly A[], message: string): Effect.Effect<A, ContaboApiError> =>
  items[0] === undefined ? Effect.fail(error(message)) : Effect.succeed(items[0])
const matchesLabels = (node: ProviderNode, labels: Readonly<Record<string, string>>): boolean => {
  const values: Readonly<Record<string, string>> = {
    'managed-by': node.metadata.managedBy,
    'organization-id': node.metadata.organizationId,
    'node-id': node.metadata.nodeId,
    'operation-id': node.metadata.operationId,
    'image-version': node.metadata.imageVersion,
  }
  return Object.entries(labels).every(([key, expected]) => values[key] === expected)
}
export const makeContaboHttpApi = (
  http: JsonHttpClientShape,
  options: ContaboHttpOptions,
): ContaboApi => ({
  regions: () =>
    Effect.flatMap(paginatedData(http, options.requestId, '/v1/compute/regions'), (items) =>
      Effect.forEach(items, (item) => {
        const id = text(item, 'name') ?? text(item, 'region')
        return id === undefined
          ? Effect.fail(error('invalid Contabo region'))
          : Effect.succeed({ id, name: text(item, 'displayName') ?? id })
      }),
    ),
  products: (region) =>
    Effect.flatMap(
      paginatedData(
        http,
        options.requestId,
        `/v1/compute/products${region === undefined ? '' : `?region=${encodeURIComponent(region)}`}`,
      ),
      (items) =>
        Effect.forEach(items, (item) => {
          const id = text(item, 'productId')
          const itemRegion = text(item, 'region') ?? region
          const cpu = number(item, 'cpuCores') ?? number(item, 'cpu')
          const ramMiB = number(item, 'ramMb') ?? number(item, 'ramMiB')
          const diskGiB = number(item, 'diskGb') ?? number(item, 'diskGiB')
          const monthly = number(item, 'price') ?? number(item, 'monthlyPrice')
          return id === undefined ||
            itemRegion === undefined ||
            cpu === undefined ||
            ramMiB === undefined ||
            diskGiB === undefined ||
            monthly === undefined
            ? Effect.fail(error('invalid Contabo product'))
            : Effect.succeed({ id, region: itemRegion, cpu, ramMiB, diskGiB, monthly })
        }),
    ),
  images: () =>
    Effect.flatMap(paginatedData(http, options.requestId, '/v1/compute/images'), (items) =>
      Effect.forEach(items, (item) => {
        const id = text(item, 'imageId')
        const name = text(item, 'name')
        return id === undefined || name === undefined
          ? Effect.fail(error('invalid Contabo image'))
          : Effect.succeed({
              id,
              name,
              architecture:
                text(item, 'architecture') === 'arm64' ? ('arm64' as const) : ('amd64' as const),
            })
      }),
    ),
  instances: (labels) =>
    Effect.flatMap(paginatedData(http, options.requestId, '/v1/compute/instances'), (items) =>
      Effect.map(Effect.forEach(items, decodeNode), (nodes) =>
        nodes.filter((node) => matchesLabels(node, labels)),
      ),
    ),
  createInstance: (input) =>
    Effect.flatMap(encodeMetadataName(input), (displayName) =>
      Effect.flatMap(
        request(http, options.requestId, 'POST', '/v1/compute/instances', {
          imageId: input.imageId,
          productId: input.planId,
          region: input.regionId,
          period: options.contractPeriodMonths,
          displayName,
          userData: input.cloudInit,
        }),
        (response) =>
          Effect.flatMap(data(response.body), (items) =>
            Effect.flatMap(first(items, 'Contabo create response is empty'), decodeNode),
          ),
      ),
    ),
  getInstance: (id) =>
    Effect.flatMap(
      request(http, options.requestId, 'GET', `/v1/compute/instances/${encodeURIComponent(id)}`),
      (response) =>
        Effect.flatMap(data(response.body), (items) =>
          Effect.flatMap(first(items, 'Contabo instance response is empty'), decodeNode),
        ),
    ),
  action: (id, action, body) =>
    Effect.as(
      request(
        http,
        options.requestId,
        'POST',
        `/v1/compute/instances/${encodeURIComponent(id)}/${action === 'reinstall' ? 'reinstall' : `actions/${action}`}`,
        body,
      ),
      undefined,
    ),
  scheduleCancellation: (id) => {
    const cancellation = options.cancellation(id)
    return Effect.as(
      request(
        http,
        options.requestId,
        'POST',
        `/v1/compute/instances/${encodeURIComponent(id)}/cancel`,
        { cancelDate: cancellation.cancellationDate },
      ),
      cancellation,
    )
  },
  secureWipeAndStop: options.secureWipeAndStop,
  createSnapshot: (id, name) =>
    Effect.flatMap(
      request(
        http,
        options.requestId,
        'POST',
        `/v1/compute/instances/${encodeURIComponent(id)}/snapshots`,
        { name, description: 'Gridora managed snapshot' },
      ),
      (response) =>
        Effect.flatMap(data(response.body), (items) =>
          Effect.flatMap(first(items, 'Contabo snapshot response is empty'), (item) => {
            const snapshotId = text(item, 'snapshotId')
            return snapshotId === undefined
              ? Effect.fail(error('Contabo snapshot response is missing snapshotId'))
              : Effect.succeed({ id: snapshotId, state: 'creating' as const })
          }),
        ),
    ),
  deleteSnapshot: (providerNodeId, snapshotId) =>
    Effect.as(
      request(
        http,
        options.requestId,
        'DELETE',
        `/v1/compute/instances/${encodeURIComponent(providerNodeId)}/snapshots/${encodeURIComponent(snapshotId)}`,
      ),
      undefined,
    ),
  replaceFirewall: (id, rules) => {
    const firewallId = options.firewallIdForInstance(id)
    const ownership = options.firewallOwnershipDescription(id)
    return Effect.flatMap(
      request(http, options.requestId, 'GET', `/v1/firewalls/${encodeURIComponent(firewallId)}`),
      (response) =>
        Effect.flatMap(data(response.body), (firewalls) =>
          Effect.flatMap(first(firewalls, 'Contabo firewall response is empty'), (firewall) => {
            if (text(firewall, 'description') !== ownership)
              return Effect.fail(
                error('refusing to modify a firewall without exact Gridora ownership'),
              )
            const existingInbound = field(field(firewall, 'rules'), 'inbound')
            if (!Array.isArray(existingInbound))
              return Effect.fail(error('Contabo firewall response lacks inbound rules'))
            const preserved = existingInbound.filter(
              (rule) => text(rule, 'displayName') !== ownership,
            )
            const desired: unknown[] = []
            for (const rule of rules) {
              if (
                typeof rule !== 'object' ||
                rule === null ||
                !('protocol' in rule) ||
                !('portFrom' in rule) ||
                !('portTo' in rule) ||
                !('sourceCidrs' in rule) ||
                (rule.protocol !== 'tcp' && rule.protocol !== 'udp') ||
                typeof rule.portFrom !== 'number' ||
                typeof rule.portTo !== 'number' ||
                !Array.isArray(rule.sourceCidrs) ||
                !rule.sourceCidrs.every((cidr) => typeof cidr === 'string')
              )
                return Effect.fail(error('invalid normalized firewall rule'))
              const cidrs = rule.sourceCidrs.filter(
                (cidr): cidr is string => typeof cidr === 'string',
              )
              desired.push({
                protocol: rule.protocol,
                destPorts: [
                  rule.portFrom === rule.portTo
                    ? String(rule.portFrom)
                    : `${rule.portFrom}-${rule.portTo}`,
                ],
                srcCidr: {
                  ipv4: cidrs.filter((cidr) => !cidr.includes(':')),
                  ipv6: cidrs.filter((cidr) => cidr.includes(':')),
                },
                action: 'accept',
                status: 'active',
                displayName: ownership,
              })
            }
            return Effect.andThen(
              Effect.as(
                request(
                  http,
                  options.requestId,
                  'PUT',
                  `/v1/firewalls/${encodeURIComponent(firewallId)}`,
                  { rules: { inbound: [...preserved, ...desired] } },
                ),
                undefined,
              ),
              Effect.as(
                request(
                  http,
                  options.requestId,
                  'POST',
                  `/v1/firewalls/${encodeURIComponent(firewallId)}/instances/${encodeURIComponent(id)}`,
                ),
                undefined,
              ),
            )
          }),
        ),
    )
  },
})

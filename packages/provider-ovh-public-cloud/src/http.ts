import { Effect } from 'effect'
import type { CreateNodeInput, JsonHttpClientShape, ProviderNode } from '@gridora/provider-sdk'
import type { OvhApiError, OvhOpenStackApi } from './index.js'

export interface OvhOpenStackHttpOptions {
  readonly regions: readonly { readonly id: string; readonly name: string }[]
  readonly regionId: string
  readonly networkHttp: JsonHttpClientShape
  readonly securityGroupIdForServer: (providerNodeId: string) => string
  readonly securityGroupOwnershipDescription: (providerNodeId: string) => string
}
const failure = (message: string, status?: number): OvhApiError => ({
  message,
  ...(status === undefined ? {} : { status }),
})
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined
const stringField = (value: unknown, key: string): string | undefined => {
  const result = field(value, key)
  return typeof result === 'string' ? result : undefined
}
const numberField = (value: unknown, key: string): number | undefined => {
  const result = field(value, key)
  return typeof result === 'number' ? result : undefined
}
const request = (
  http: JsonHttpClientShape,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) =>
  Effect.flatMap(
    http.request({ method, path, ...(body === undefined ? {} : { body }) }),
    (response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(failure(`OpenStack API returned HTTP ${response.status}`, response.status)),
  )
const arrayField = (body: unknown, key: string): Effect.Effect<readonly unknown[], OvhApiError> => {
  const value = field(body, key)
  return Array.isArray(value)
    ? Effect.succeed(value)
    : Effect.fail(failure(`OpenStack response is missing ${key}`))
}
const metadata = (value: unknown) => field(value, 'metadata')
const decodeNode = (value: unknown): Effect.Effect<ProviderNode, OvhApiError> => {
  const id = stringField(value, 'id')
  const name = stringField(value, 'name')
  const status = stringField(value, 'status')?.toLowerCase()
  const meta = metadata(value)
  const organizationId = stringField(meta, 'organization-id')
  const nodeId = stringField(meta, 'node-id')
  const operationId = stringField(meta, 'operation-id')
  const imageVersion = stringField(meta, 'image-version')
  const regionId = stringField(meta, 'gridora-region')
  const planId = stringField(field(value, 'flavor'), 'id')
  if (
    id === undefined ||
    name === undefined ||
    organizationId === undefined ||
    nodeId === undefined ||
    operationId === undefined ||
    imageVersion === undefined ||
    regionId === undefined ||
    planId === undefined
  )
    return Effect.fail(failure('OpenStack server is missing required Gridora metadata'))
  const addressesValue = field(value, 'addresses')
  const addresses: string[] = []
  if (typeof addressesValue === 'object' && addressesValue !== null)
    for (const network of Object.values(addressesValue))
      if (Array.isArray(network))
        for (const item of network) {
          const address = stringField(item, 'addr')
          if (address !== undefined) addresses.push(address)
        }
  const state: ProviderNode['state'] =
    status === 'active'
      ? 'active'
      : status === 'shutoff' || status === 'stopped'
        ? 'stopped'
        : status === 'build'
          ? 'creating'
          : status === 'rebuild'
            ? 'rebuilding'
            : 'unknown'
  return Effect.succeed({
    id,
    name,
    state,
    regionId,
    planId,
    addresses,
    metadata: { managedBy: 'gridora', organizationId, nodeId, operationId, imageVersion },
  })
}
const serverPath = (id: string) => `/servers/${encodeURIComponent(id)}`
const matchesMetadata = (node: ProviderNode, filter: Readonly<Record<string, string>>): boolean => {
  const values: Readonly<Record<string, string>> = {
    'managed-by': node.metadata.managedBy,
    'organization-id': node.metadata.organizationId,
    'node-id': node.metadata.nodeId,
    'operation-id': node.metadata.operationId,
    'image-version': node.metadata.imageVersion,
  }
  return Object.entries(filter).every(([key, expected]) => values[key] === expected)
}
const reconcileSecurityGroup = (
  options: OvhOpenStackHttpOptions,
  providerNodeId: string,
  rules: readonly unknown[],
): Effect.Effect<void, OvhApiError> => {
  const securityGroupId = options.securityGroupIdForServer(providerNodeId)
  const ownership = options.securityGroupOwnershipDescription(providerNodeId)
  return Effect.flatMap(
    request(
      options.networkHttp,
      'GET',
      `/v2.0/security-groups/${encodeURIComponent(securityGroupId)}`,
    ),
    (groupResponse) => {
      if (stringField(field(groupResponse.body, 'security_group'), 'description') !== ownership)
        return Effect.fail(
          failure('refusing to modify a security group without exact Gridora ownership'),
        )
      return Effect.flatMap(
        request(
          options.networkHttp,
          'GET',
          `/v2.0/security-group-rules?security_group_id=${encodeURIComponent(securityGroupId)}`,
        ),
        (response) =>
          Effect.flatMap(arrayField(response.body, 'security_group_rules'), (existing) => {
            const removeOwned = Effect.forEach(
              existing,
              (item) => {
                const ruleId = stringField(item, 'id')
                const ruleDescription = stringField(item, 'description')
                return ruleDescription !== ownership
                  ? Effect.void
                  : ruleId === undefined
                    ? Effect.fail(failure('invalid owned Neutron security group rule'))
                    : Effect.as(
                        request(
                          options.networkHttp,
                          'DELETE',
                          `/v2.0/security-group-rules/${encodeURIComponent(ruleId)}`,
                        ),
                        undefined,
                      )
              },
              { discard: true },
            )
            const addDesired = Effect.forEach(
              rules,
              (rule) => {
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
                  !Array.isArray(rule.sourceCidrs)
                )
                  return Effect.fail(failure('invalid normalized firewall rule'))
                return Effect.forEach(
                  rule.sourceCidrs,
                  (cidr) =>
                    typeof cidr !== 'string'
                      ? Effect.fail(failure('invalid firewall CIDR'))
                      : Effect.as(
                          request(options.networkHttp, 'POST', '/v2.0/security-group-rules', {
                            security_group_rule: {
                              security_group_id: securityGroupId,
                              description: ownership,
                              direction: 'ingress',
                              ethertype: cidr.includes(':') ? 'IPv6' : 'IPv4',
                              protocol: rule.protocol,
                              port_range_min: rule.portFrom,
                              port_range_max: rule.portTo,
                              remote_ip_prefix: cidr,
                            },
                          }),
                          undefined,
                        ),
                  { discard: true },
                )
              },
              { discard: true },
            )
            return Effect.andThen(removeOwned, addDesired)
          }),
      )
    },
  )
}
export const makeOvhOpenStackHttpApi = (
  http: JsonHttpClientShape,
  options: OvhOpenStackHttpOptions,
): OvhOpenStackApi => ({
  regions: () => Effect.succeed(options.regions),
  flavors: () =>
    Effect.flatMap(request(http, 'GET', '/flavors/detail'), (response) =>
      Effect.flatMap(arrayField(response.body, 'flavors'), (items) =>
        Effect.forEach(items, (item) => {
          const id = stringField(item, 'id')
          const vcpus = numberField(item, 'vcpus')
          const ramMiB = numberField(item, 'ram')
          const diskGiB = numberField(item, 'disk')
          return id === undefined ||
            vcpus === undefined ||
            ramMiB === undefined ||
            diskGiB === undefined
            ? Effect.fail(failure('invalid OpenStack flavor'))
            : Effect.succeed({ id, region: options.regionId, vcpus, ramMiB, diskGiB })
        }),
      ),
    ),
  images: () =>
    Effect.flatMap(request(http, 'GET', '/images/detail'), (response) =>
      Effect.flatMap(arrayField(response.body, 'images'), (items) =>
        Effect.forEach(items, (item) => {
          const id = stringField(item, 'id')
          const name = stringField(item, 'name')
          if (id === undefined || name === undefined)
            return Effect.fail(failure('invalid OpenStack image'))
          const architecture = stringField(field(item, 'metadata'), 'architecture')
          return Effect.succeed({
            id,
            name,
            architecture:
              architecture === 'arm64' || architecture === 'aarch64'
                ? ('arm64' as const)
                : ('amd64' as const),
          })
        }),
      ),
    ),
  servers: (filter) =>
    Effect.flatMap(request(http, 'GET', '/servers/detail'), (response) =>
      Effect.flatMap(arrayField(response.body, 'servers'), (items) =>
        Effect.map(Effect.forEach(items, decodeNode), (nodes) =>
          nodes.filter((node) => matchesMetadata(node, filter)),
        ),
      ),
    ),
  createServer: (input: CreateNodeInput, meta) =>
    Effect.flatMap(
      request(http, 'POST', '/servers', {
        server: {
          name: input.name,
          flavorRef: input.planId,
          imageRef: input.imageId,
          user_data: input.cloudInit,
          metadata: { ...meta, 'gridora-region': input.regionId },
        },
      }),
      (response) => {
        const id = stringField(field(response.body, 'server'), 'id')
        return id === undefined
          ? Effect.fail(failure('OpenStack create response is missing server id'))
          : Effect.flatMap(request(http, 'GET', serverPath(id)), (detail) =>
              decodeNode(field(detail.body, 'server')),
            )
      },
    ),
  getServer: (id) =>
    Effect.flatMap(request(http, 'GET', serverPath(id)), (response) =>
      decodeNode(field(response.body, 'server')),
    ),
  action: (id, action, body) =>
    Effect.as(
      request(
        http,
        'POST',
        `${serverPath(id)}/action`,
        action === 'start'
          ? { 'os-start': null }
          : action === 'stop'
            ? { 'os-stop': null }
            : action === 'reboot'
              ? { reboot: { type: 'SOFT' } }
              : { rebuild: body },
      ),
      undefined,
    ),
  deleteServer: (id) => Effect.as(request(http, 'DELETE', serverPath(id)), undefined),
  createSnapshot: (id, name, metadata) =>
    Effect.flatMap(
      request(http, 'POST', `${serverPath(id)}/action`, { createImage: { name, metadata } }),
      (response) => {
        const location = response.headers.location
        const snapshotId = location?.split('/').at(-1)
        return snapshotId === undefined
          ? Effect.fail(failure('OpenStack snapshot response is missing Location image id'))
          : Effect.succeed({ id: snapshotId, state: 'creating' as const })
      },
    ),
  getSnapshot: (id) =>
    Effect.flatMap(request(http, 'GET', `/images/${encodeURIComponent(id)}`), (response) => {
      const image = field(response.body, 'image')
      const snapshotId = stringField(image, 'id')
      const imageMetadata = field(image, 'metadata')
      const organizationId = stringField(imageMetadata, 'organization-id')
      const nodeId = stringField(imageMetadata, 'node-id')
      return snapshotId === undefined || organizationId === undefined || nodeId === undefined
        ? Effect.fail(failure('OpenStack snapshot lacks Gridora ownership metadata'))
        : Effect.succeed({ id: snapshotId, organizationId, nodeId })
    }),
  deleteSnapshot: (id) =>
    Effect.as(request(http, 'DELETE', `/images/${encodeURIComponent(id)}`), undefined),
  replaceSecurityGroupRules: (id, rules) => reconcileSecurityGroup(options, id, rules),
})

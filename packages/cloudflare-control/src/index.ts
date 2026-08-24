import { Context, Effect, Schema } from 'effect'

export class CloudflareControlError extends Schema.TaggedError<CloudflareControlError>()(
  'CloudflareControlError',
  { operation: Schema.String, message: Schema.String, retryable: Schema.Boolean },
) {}
export interface CloudflareApiShape {
  readonly request: (input: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    readonly path: string
    readonly body?: unknown
  }) => Effect.Effect<unknown, CloudflareControlError>
}
export class CloudflareApi extends Context.Service<CloudflareApi, CloudflareApiShape>()(
  '@gridora/cloudflare-control/CloudflareApi',
) {}
export interface OrganizationResource {
  readonly organizationId: string
  readonly ownerResourceId: string
}
export interface DnsRecordInput extends OrganizationResource {
  readonly zoneId: string
  readonly name: string
  readonly type: 'A' | 'AAAA' | 'SRV' | 'CNAME'
  readonly content: string
  readonly proxied: false
}
export interface DnsRecordTransferInput {
  readonly organizationId: string
  readonly zoneId: string
  readonly name: string
  readonly type: 'A' | 'AAAA'
  readonly expectedOwnerResourceId: string
  readonly expectedContent: string
  readonly nextOwnerResourceId: string
  readonly nextContent: string
}
export interface TunnelInput extends OrganizationResource {
  readonly accountId: string
  readonly name: string
}
export interface AccessApplicationInput extends OrganizationResource {
  readonly accountId: string
  readonly name: string
  readonly domain: string
}
export const resourceComment = (input: OrganizationResource): string =>
  `gridora:org=${input.organizationId};owner=${input.ownerResourceId}`
export const tunnelResourceName = (input: TunnelInput): string =>
  `gridora:${input.organizationId}:${input.ownerResourceId}:${input.name}`
export const accessResourceName = (input: AccessApplicationInput): string =>
  `gridora:${input.organizationId}:${input.ownerResourceId}:${input.name}`
interface NamedResource {
  readonly id: string
  readonly name: string
  readonly domain?: string
  readonly type?: string
}
const decodeNamedResources = (
  input: unknown,
  operation: string,
): Effect.Effect<readonly NamedResource[], CloudflareControlError> => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('result' in input) ||
    !Array.isArray(input.result)
  )
    return Effect.fail(
      new CloudflareControlError({
        operation,
        message: 'invalid Cloudflare list response',
        retryable: false,
      }),
    )
  const resources: NamedResource[] = []
  for (const item of input.result) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      !('name' in item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string'
    )
      return Effect.fail(
        new CloudflareControlError({
          operation,
          message: 'invalid Cloudflare resource in list response',
          retryable: false,
        }),
      )
    resources.push({
      id: item.id,
      name: item.name,
      ...('domain' in item && typeof item.domain === 'string' ? { domain: item.domain } : {}),
      ...('type' in item && typeof item.type === 'string' ? { type: item.type } : {}),
    })
  }
  return Effect.succeed(resources)
}
interface DnsRecord {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly content: string
  readonly comment?: string
}
const decodeDnsRecords = (
  input: unknown,
): Effect.Effect<readonly DnsRecord[], CloudflareControlError> => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('result' in input) ||
    !Array.isArray(input.result)
  )
    return Effect.fail(
      new CloudflareControlError({
        operation: 'listDnsRecords',
        message: 'invalid Cloudflare DNS response',
        retryable: false,
      }),
    )
  const records: DnsRecord[] = []
  for (const item of input.result) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      !('type' in item) ||
      !('name' in item) ||
      !('content' in item) ||
      typeof item.id !== 'string' ||
      typeof item.type !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.content !== 'string'
    )
      return Effect.fail(
        new CloudflareControlError({
          operation: 'listDnsRecords',
          message: 'invalid DNS record in Cloudflare response',
          retryable: false,
        }),
      )
    records.push({
      id: item.id,
      type: item.type,
      name: item.name,
      content: item.content,
      ...('comment' in item && typeof item.comment === 'string' ? { comment: item.comment } : {}),
    })
  }
  return Effect.succeed(records)
}
const findDnsRecords = (
  api: CloudflareApiShape,
  input: Pick<DnsRecordInput, 'zoneId' | 'name' | 'type'>,
) =>
  Effect.flatMap(
    api.request({
      method: 'GET',
      path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records?type=${encodeURIComponent(input.type)}&name.exact=${encodeURIComponent(input.name)}&match=all`,
    }),
    decodeDnsRecords,
  )
const ownedRecord = (
  records: readonly DnsRecord[],
  owner: OrganizationResource,
): Effect.Effect<DnsRecord | undefined, CloudflareControlError> => {
  if (records.length > 1)
    return Effect.fail(
      new CloudflareControlError({
        operation: 'reconcileDnsRecord',
        message: 'multiple exact DNS records are ambiguous',
        retryable: false,
      }),
    )
  const record = records[0]
  if (record === undefined) return Effect.succeed(undefined)
  return record.comment === resourceComment(owner)
    ? Effect.succeed(record)
    : Effect.fail(
        new CloudflareControlError({
          operation: 'reconcileDnsRecord',
          message: 'matching DNS record is not owned by this Gridora resource',
          retryable: false,
        }),
      )
}
export const makeCloudflareControl = (api: CloudflareApiShape) => ({
  upsertDnsRecord: (input: DnsRecordInput) =>
    Effect.flatMap(findDnsRecords(api, input), (records) =>
      Effect.flatMap(ownedRecord(records, input), (record) =>
        api.request({
          method: record === undefined ? 'POST' : 'PUT',
          path:
            record === undefined
              ? `/zones/${encodeURIComponent(input.zoneId)}/dns_records`
              : `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
          body: {
            type: input.type,
            name: input.name,
            content: input.content,
            proxied: false,
            ttl: 1,
            comment: resourceComment(input),
          },
        }),
      ),
    ),
  deleteDnsRecord: (
    input: OrganizationResource & {
      readonly zoneId: string
      readonly name: string
      readonly type: DnsRecordInput['type']
      /** A persisted provider identity makes absence fail closed. */
      readonly expectedRecordId?: string
      /** Bind teardown to immutable published content when available. */
      readonly expectedContent?: string
    },
  ) =>
    Effect.flatMap(findDnsRecords(api, input), (records) =>
      Effect.flatMap(ownedRecord(records, input), (record) =>
        record === undefined
          ? input.expectedRecordId === undefined
            ? Effect.succeed({ deleted: false })
            : Effect.fail(
                new CloudflareControlError({
                  operation: 'deleteDnsRecord',
                  message: 'the exact persisted DNS record is absent from its immutable zone',
                  retryable: false,
                }),
              )
          : input.expectedRecordId !== undefined && record.id !== input.expectedRecordId
            ? Effect.fail(
                new CloudflareControlError({
                  operation: 'deleteDnsRecord',
                  message: 'DNS teardown found a different provider record identity',
                  retryable: false,
                }),
              )
            : input.expectedContent !== undefined && record.content !== input.expectedContent
              ? Effect.fail(
                  new CloudflareControlError({
                    operation: 'deleteDnsRecord',
                    message:
                      'DNS teardown record content differs from immutable publication evidence',
                    retryable: false,
                  }),
                )
              : Effect.as(
                  api.request({
                    method: 'DELETE',
                    path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
                  }),
                  { deleted: true, recordId: record.id },
                ),
      ),
    ),
  /**
   * Transfers one exact Gridora-owned record. This is intentionally narrower
   * than an upsert: a missing, foreign, multiply-matched, or mixed source/next
   * state fails closed. Re-reading the exact next state adopts a lost PUT
   * response without issuing a second mutation.
   */
  transferDnsRecord: (
    input: DnsRecordTransferInput,
  ): Effect.Effect<
    { readonly recordId: string; readonly disposition: 'applied' | 'adopted' },
    CloudflareControlError
  > =>
    Effect.gen(function* () {
      const records = yield* findDnsRecords(api, input)
      if (records.length !== 1)
        return yield* Effect.fail(
          new CloudflareControlError({
            operation: 'transferDnsRecord',
            message: 'DNS transfer requires exactly one authoritative record',
            retryable: false,
          }),
        )
      const record = records[0]!
      const expectedComment = resourceComment({
        organizationId: input.organizationId,
        ownerResourceId: input.expectedOwnerResourceId,
      })
      const nextComment = resourceComment({
        organizationId: input.organizationId,
        ownerResourceId: input.nextOwnerResourceId,
      })
      if (record.content === input.nextContent && record.comment === nextComment)
        return { recordId: record.id, disposition: 'adopted' as const }
      if (record.content !== input.expectedContent || record.comment !== expectedComment)
        return yield* Effect.fail(
          new CloudflareControlError({
            operation: 'transferDnsRecord',
            message: 'DNS transfer source ownership or content does not match',
            retryable: false,
          }),
        )
      return yield* api
        .request({
          method: 'PUT',
          path: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
          body: {
            type: input.type,
            name: input.name,
            content: input.nextContent,
            proxied: false,
            ttl: 1,
            comment: nextComment,
          },
        })
        .pipe(
          Effect.as({ recordId: record.id, disposition: 'applied' as const }),
          Effect.catch((lostResponse) =>
            findDnsRecords(api, input).pipe(
              Effect.flatMap((reread) => {
                const adopted = reread[0]
                return reread.length === 1 &&
                  adopted !== undefined &&
                  adopted.id === record.id &&
                  adopted.content === input.nextContent &&
                  adopted.comment === nextComment
                  ? Effect.succeed({ recordId: adopted.id, disposition: 'adopted' as const })
                  : Effect.fail(lostResponse)
              }),
            ),
          ),
        )
    }),
  createTunnel: (input: TunnelInput) =>
    Effect.flatMap(
      api.request({
        method: 'GET',
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel?name=${encodeURIComponent(tunnelResourceName(input))}&is_deleted=false`,
      }),
      (response) =>
        Effect.flatMap(decodeNamedResources(response, 'createTunnel'), (resources) => {
          if (
            resources.length > 1 ||
            resources.some((resource) => resource.name !== tunnelResourceName(input))
          )
            return Effect.fail(
              new CloudflareControlError({
                operation: 'createTunnel',
                message: 'matching tunnel is ambiguous or foreign',
                retryable: false,
              }),
            )
          const existing = resources[0]
          return existing === undefined
            ? api.request({
                method: 'POST',
                path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`,
                body: { name: tunnelResourceName(input), config_src: 'cloudflare' },
              })
            : Effect.succeed({ success: true, result: existing, adopted: true })
        }),
    ),
  deleteTunnel: (input: TunnelInput & { readonly tunnelId: string }) =>
    Effect.flatMap(
      api.request({
        method: 'GET',
        path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`,
      }),
      (response) => {
        if (
          typeof response !== 'object' ||
          response === null ||
          !('result' in response) ||
          typeof response.result !== 'object' ||
          response.result === null ||
          !('id' in response.result) ||
          !('name' in response.result) ||
          response.result.id !== input.tunnelId ||
          response.result.name !== tunnelResourceName(input)
        )
          return Effect.fail(
            new CloudflareControlError({
              operation: 'deleteTunnel',
              message: 'tunnel is missing or not owned by this Gridora organization resource',
              retryable: false,
            }),
          )
        return api.request({
          method: 'DELETE',
          path: `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(input.tunnelId)}`,
        })
      },
    ),
  createAccessApplication: (input: AccessApplicationInput) =>
    Effect.flatMap(
      api.request({
        method: 'GET',
        path: `/accounts/${encodeURIComponent(input.accountId)}/access/apps?domain=${encodeURIComponent(input.domain)}`,
      }),
      (response) =>
        Effect.flatMap(decodeNamedResources(response, 'createAccessApplication'), (resources) => {
          const exactDomain = resources.filter((resource) => resource.domain === input.domain)
          if (
            resources.length !== exactDomain.length ||
            exactDomain.length > 1 ||
            exactDomain.some(
              (resource) =>
                resource.name !== accessResourceName(input) || resource.type !== 'self_hosted',
            )
          )
            return Effect.fail(
              new CloudflareControlError({
                operation: 'createAccessApplication',
                message: 'matching Access application is ambiguous or foreign',
                retryable: false,
              }),
            )
          const existing = exactDomain[0]
          return existing === undefined
            ? api.request({
                method: 'POST',
                path: `/accounts/${encodeURIComponent(input.accountId)}/access/apps`,
                body: {
                  type: 'self_hosted',
                  name: accessResourceName(input),
                  domain: input.domain,
                },
              })
            : Effect.succeed({ success: true, result: existing, adopted: true })
        }),
    ),
})

import { Effect, Schema } from 'effect'
import { tunnelResourceName } from '@gridora/cloudflare-control'

export class NodeTerminationTunnelError extends Schema.TaggedError<NodeTerminationTunnelError>()(
  'NodeTerminationTunnelError',
  { code: Schema.String },
) {}

export interface NodeTerminationTunnelTarget {
  readonly organizationId: string
  readonly nodeId: string
  readonly tunnelId: string
}

export interface NodeTerminationTunnelAdapter {
  /** Deletes exactly one owned tunnel. A lost DELETE response is adopted only after a 404 reread. */
  readonly deleteExact: (
    target: NodeTerminationTunnelTarget,
  ) => Effect.Effect<{ readonly disposition: 'deleted' | 'adopted' }, NodeTerminationTunnelError>
  /** A present tunnel never proves a prior DELETE was not issued. */
  readonly observeExact: (
    target: NodeTerminationTunnelTarget,
  ) => Effect.Effect<'deleted' | 'present' | 'unknown', NodeTerminationTunnelError>
}

const failure = (code: string) => new NodeTerminationTunnelError({ code })

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const ownedTunnel = (
  value: unknown,
  target: NodeTerminationTunnelTarget,
  accountId: string,
): boolean => {
  const response = record(value)
  const result = response === undefined ? undefined : record(response.result)
  return (
    typeof result?.id === 'string' &&
    result.id === target.tunnelId &&
    typeof result.name === 'string' &&
    result.name ===
      tunnelResourceName({
        accountId,
        organizationId: target.organizationId,
        ownerResourceId: target.nodeId,
        name: 'Node tunnel',
      }) &&
    result.config_src === 'cloudflare'
  )
}

const validAccountId = (value: string): boolean => /^[a-f0-9]{32}$/.test(value)
const validTunnelId = (value: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(value)

/**
 * A deliberately narrow Cloudflare Tunnel adapter. It owns only the two fixed
 * cfd_tunnel endpoints required by retirement and does not expose arbitrary
 * paths, commands, or credential material to a workflow.
 */
export const makeNodeTerminationTunnelAdapter = (input: {
  readonly accountId: string
  readonly apiToken: { readonly get: () => Promise<string> }
  readonly fetch?: typeof fetch
}): NodeTerminationTunnelAdapter => {
  const transport = input.fetch ?? fetch
  const request = (
    method: 'GET' | 'DELETE',
    target: NodeTerminationTunnelTarget,
  ): Effect.Effect<
    { readonly status: number; readonly body: unknown },
    NodeTerminationTunnelError
  > =>
    Effect.gen(function* () {
      if (!validAccountId(input.accountId)) return yield* failure('node_tunnel_account_id_invalid')
      if (!validTunnelId(target.tunnelId)) return yield* failure('node_tunnel_id_invalid')
      const token = yield* Effect.tryPromise({
        try: () => input.apiToken.get(),
        catch: () => failure('node_tunnel_api_token_unavailable'),
      })
      if (token.length < 20) return yield* failure('node_tunnel_api_token_invalid')
      const response = yield* Effect.tryPromise({
        try: () =>
          transport(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}` +
              `/cfd_tunnel/${encodeURIComponent(target.tunnelId)}`,
            {
              method,
              redirect: 'error',
              headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            },
          ),
        catch: () => failure(`node_tunnel_${method.toLowerCase()}_transport_unavailable`),
      })
      const bodyText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => failure(`node_tunnel_${method.toLowerCase()}_response_unavailable`),
      })
      if (bodyText.length > 1_048_576)
        return yield* failure(`node_tunnel_${method.toLowerCase()}_response_too_large`)
      const body =
        bodyText.length === 0
          ? undefined
          : yield* Effect.try({
              try: () => JSON.parse(bodyText) as unknown,
              catch: () => failure(`node_tunnel_${method.toLowerCase()}_response_invalid`),
            })
      return { status: response.status, body }
    })

  const read = (
    target: NodeTerminationTunnelTarget,
  ): Effect.Effect<'deleted' | 'present', NodeTerminationTunnelError> =>
    request('GET', target).pipe(
      Effect.flatMap(({ status, body }) => {
        if (status === 404) return Effect.succeed('deleted' as const)
        if (status < 200 || status >= 300) return Effect.fail(failure('node_tunnel_read_failed'))
        return ownedTunnel(body, target, input.accountId)
          ? Effect.succeed('present' as const)
          : Effect.fail(failure('node_tunnel_ownership_mismatch'))
      }),
    )

  return {
    deleteExact: (target) =>
      Effect.gen(function* () {
        const before = yield* read(target)
        if (before !== 'present') return yield* failure('node_tunnel_missing_before_delete')
        const deleted = yield* Effect.result(
          request('DELETE', target).pipe(
            Effect.flatMap(({ status }) =>
              status >= 200 && status < 300
                ? Effect.succeed({ disposition: 'deleted' as const })
                : Effect.fail(failure('node_tunnel_delete_failed')),
            ),
          ),
        )
        if (deleted._tag === 'Success') return deleted.success
        // A DELETE response loss must never retry DELETE. Only a follow-up
        // 404 for this exact id can adopt the side effect.
        const after = yield* read(target)
        if (after === 'deleted') return { disposition: 'adopted' as const }
        return yield* deleted.failure
      }),
    observeExact: (target) =>
      read(target).pipe(Effect.catch(() => Effect.succeed('unknown' as const))),
  }
}

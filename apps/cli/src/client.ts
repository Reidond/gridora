import { Context, Effect } from 'effect'
import { CliError } from './errors.js'

export interface ApiRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  /** The Node adapter inserts the selected organization into this canonical tenant path. */
  readonly organizationScoped?: boolean
  readonly organization?: string
  readonly body?: unknown
  readonly idempotencyKey?: string
}

export interface ApiResponse {
  readonly status: number
  readonly data: unknown
  readonly operationId?: string
}

/**
 * A live stream is deliberately separate from the archive request: the
 * archive page remains bounded and retryable, while the ticket is one-use.
 */
export interface LiveLogStreamRequest {
  readonly organization: string
  readonly serverId: string
  readonly component?: string
  readonly level?: string
  readonly from?: string
  readonly to?: string
}

export interface LiveLogStreamEvent {
  readonly sequence: number
  readonly entry: unknown
}

/** Port implemented by the generated canonical API client at the Node entrypoint. */
export class GridoraApi extends Context.Service<
  GridoraApi,
  {
    readonly request: (request: ApiRequest) => Effect.Effect<ApiResponse, CliError>
    readonly watchOperation: (
      operationId: string,
      timeoutMs: number,
      organization?: string,
    ) => Effect.Effect<unknown, CliError>
    /** Optional only to keep third-party/mock API ports source compatible. */
    readonly streamLogs?: (
      input: LiveLogStreamRequest,
    ) => Effect.Effect<ReadonlyArray<LiveLogStreamEvent>, CliError>
  }
>()('gridora/cli/GridoraApi') {}

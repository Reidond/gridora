import { Effect, Result } from 'effect'
import {
  decodeLiveLogArchiveAvailableEvent,
  type LiveLogArchiveAvailableEvent,
} from '@gridora/log-control'
import { makeLogArchiveRepositoryD1, type LogD1Database } from '@gridora/log-d1'
import { makeCloudflareLogR2Bucket, readLogArchive } from '@gridora/log-r2'
import type { LiveLogStreamDO } from '@gridora/realtime'

export interface LiveLogPublicationBindings {
  readonly DB: LogD1Database
  readonly LOGS: {
    readonly head: (key: string) => Promise<{
      readonly key: string
      readonly size: number
      readonly etag: string
      readonly customMetadata?: Readonly<Record<string, string>>
    } | null>
    readonly get: (key: string) => Promise<{
      readonly key: string
      readonly size: number
      readonly etag: string
      readonly body?: ReadableStream<Uint8Array>
      readonly customMetadata?: Readonly<Record<string, string>>
    } | null>
    readonly put: (
      key: string,
      body: Uint8Array,
      options?: {
        readonly customMetadata?: Readonly<Record<string, string>>
        readonly onlyIf?: Headers
      },
    ) => Promise<{
      readonly key: string
      readonly size: number
      readonly etag: string
      readonly customMetadata?: Readonly<Record<string, string>>
    } | null>
    readonly delete: (key: string) => Promise<void>
  }
  readonly LIVE_LOG_STREAM: {
    readonly getByName: (name: string) => Pick<LiveLogStreamDO, 'publish'>
  }
}

export type LiveLogPublicationDisposition =
  | {
      readonly disposition: 'ack'
      readonly event?: LiveLogArchiveAvailableEvent
      readonly reason: string
    }
  | {
      readonly disposition: 'retry'
      readonly event?: LiveLogArchiveAvailableEvent
      readonly reason: string
    }

const streamName = (organizationId: string, serverId: string, streamEpoch: string): string =>
  `${encodeURIComponent(organizationId)}:logs:${encodeURIComponent(serverId)}:${encodeURIComponent(streamEpoch)}`

/**
 * Reads the exact immutable archive after D1 has accepted it. Queue delivery is
 * at-least-once; the target Durable Object owns archive-ID deduplication.
 */
export const processLiveLogArchiveAvailable = async (
  bindings: LiveLogPublicationBindings,
  body: unknown,
): Promise<LiveLogPublicationDisposition> => {
  const decoded = await Effect.runPromise(Effect.result(decodeLiveLogArchiveAvailableEvent(body)))
  if (Result.isFailure(decoded)) return { disposition: 'ack', reason: 'invalid_schema' }
  const event = decoded.success
  const repository = makeLogArchiveRepositoryD1(bindings.DB)
  const metadataResult = await Effect.runPromise(
    Effect.result(repository.get(event.organizationId, event.archiveId)),
  )
  if (Result.isFailure(metadataResult))
    return { disposition: 'retry', event, reason: 'catalog_unavailable' }
  const metadata = metadataResult.success
  if (
    metadata === null ||
    metadata.state !== 'available' ||
    metadata.organizationId !== event.organizationId ||
    metadata.nodeId !== event.nodeId ||
    metadata.serverId !== event.serverId ||
    metadata.streamEpoch !== event.streamEpoch ||
    metadata.r2Key !== event.r2Key ||
    metadata.sha256 !== event.sha256
  )
    return { disposition: 'ack', event, reason: 'archive_identity_mismatch' }

  const archiveResult = await Effect.runPromise(
    Effect.result(
      readLogArchive(
        makeCloudflareLogR2Bucket(bindings.LOGS),
        metadata,
        event.organizationId,
        event.serverId,
      ),
    ),
  )
  if (Result.isFailure(archiveResult))
    return { disposition: 'retry', event, reason: 'archive_read_failed' }
  const archive = archiveResult.success
  const firstSequence = archive.entries[0]?.sequence
  const lastSequence = archive.entries.at(-1)?.sequence
  if (firstSequence !== event.firstSequence || lastSequence !== event.lastSequence)
    return { disposition: 'ack', event, reason: 'archive_sequence_mismatch' }

  try {
    await bindings.LIVE_LOG_STREAM.getByName(
      streamName(event.organizationId, event.serverId, event.streamEpoch),
    ).publish({
      organizationId: event.organizationId,
      serverId: event.serverId,
      streamEpoch: event.streamEpoch,
      nodeId: event.nodeId,
      archiveId: event.archiveId,
      archiveSha256: event.sha256,
      entries: archive.entries,
    })
    return { disposition: 'ack', event, reason: 'published' }
  } catch {
    return { disposition: 'retry', event, reason: 'live_stream_unavailable' }
  }
}

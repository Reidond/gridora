/**
 * Limits for the tenant-scoped live log channel.  The Durable Object keeps a
 * small replay ring, while a WebSocket that cannot accept frames is closed
 * instead of allowing an unbounded per-client queue to grow.
 */
export const LIVE_LOG_LIMITS = {
  maximumRetainedEvents: 512,
  maximumRetainedBytes: 512 * 1024,
  maximumRetentionMilliseconds: 10 * 60 * 1000,
  maximumBacklogEvents: 128,
  maximumFrameBytes: 64 * 1024,
  maximumBufferedBytes: 256 * 1024,
  maximumInboundMessageBytes: 128,
  /** Bounded durable nonce rows per organization/server stream. */
  maximumTicketsPerStream: 64,
  /** A principal cannot exhaust a stream's nonce ledger on its own. */
  maximumTicketsPerPrincipal: 8,
  /** Hibernatable socket handles are a finite per-stream resource. */
  maximumSocketsPerStream: 32,
  /** One browser/user identity gets a small reconnect/tab allowance. */
  maximumSocketsPerPrincipal: 4,
  /** Alarms close inactive hibernatable sockets before their ticket TTL. */
  maximumSocketIdleMilliseconds: 60 * 1000,
} as const

export type LiveLogBackpressureDecision = 'send' | 'close'

/**
 * Workers WebSockets expose bufferedAmount but do not provide a promise for
 * drain.  Closing at a hard bound is the only bounded strategy that remains
 * correct across hibernation and process eviction; clients reconnect using a
 * short-lived ticket and an `after` sequence.
 */
export const liveLogBackpressureDecision = (
  bufferedBytes: number,
  frameBytes: number,
): LiveLogBackpressureDecision =>
  Number.isSafeInteger(bufferedBytes) &&
  Number.isSafeInteger(frameBytes) &&
  bufferedBytes >= 0 &&
  frameBytes >= 0 &&
  frameBytes <= LIVE_LOG_LIMITS.maximumFrameBytes &&
  bufferedBytes + frameBytes <= LIVE_LOG_LIMITS.maximumBufferedBytes
    ? 'send'
    : 'close'

export interface LiveLogBacklogWindow<T> {
  readonly items: ReadonlyArray<T>
  readonly truncated: boolean
}

/** Keeps reconnect replay bounded even if the requested cursor is very old. */
export const boundedLiveLogBacklog = <T>(
  rows: ReadonlyArray<T>,
  maximum = LIVE_LOG_LIMITS.maximumBacklogEvents,
): LiveLogBacklogWindow<T> => {
  const limit =
    Number.isSafeInteger(maximum) && maximum > 0
      ? Math.min(maximum, LIVE_LOG_LIMITS.maximumBacklogEvents)
      : LIVE_LOG_LIMITS.maximumBacklogEvents
  return rows.length <= limit
    ? { items: rows, truncated: false }
    : { items: rows.slice(rows.length - limit), truncated: true }
}

export const isValidLiveLogCursor = (value: string): boolean =>
  /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))

/**
 * A replay cursor is scoped to the deployment epoch. A bare sequence would let
 * a reconnect after a server move silently skip the first events in the new
 * stream. The legacy numeric predicate remains exported for older callers,
 * while the live DO requires this compound form.
 */
export const encodeEpochLiveLogCursor = (streamEpoch: string, sequence: number): string =>
  `${encodeURIComponent(streamEpoch)}.${sequence}`

export const decodeEpochLiveLogCursor = (
  value: string,
  streamEpoch: string,
): number | undefined => {
  const separator = value.lastIndexOf('.')
  if (separator < 1) return undefined
  const encodedEpoch = value.slice(0, separator)
  const sequence = value.slice(separator + 1)
  let decodedEpoch: string
  try {
    decodedEpoch = decodeURIComponent(encodedEpoch)
  } catch {
    return undefined
  }
  return decodedEpoch === streamEpoch && isValidLiveLogCursor(sequence)
    ? Number(sequence)
    : undefined
}
